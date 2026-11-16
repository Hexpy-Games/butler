//! Raw DevTools messages between hosted pages and the Agent; up in order, one request at a time.
use super::Hosted;
use crate::ui::{
    browser::{
        engine::{PageChange, TabId},
        model::Tab,
    },
    source::agent::Jobs,
};
use futures::{
    StreamExt as _,
    channel::{mpsc, oneshot},
};
use gpui::{App, Global};
use serde_json::{Value, json};
use std::{cell::RefCell, collections::VecDeque, rc::Rc};

const BATCH_MESSAGES: usize = 256;
const BATCH_BYTES: usize = 8 << 20;

#[derive(Clone)]
struct Relay {
    queue: Rc<RefCell<VecDeque<(Value, usize)>>>,
    wake: mpsc::UnboundedSender<()>,
    /// Ends the attach stream of the current attachment.
    abort: Rc<RefCell<Option<oneshot::Sender<()>>>>,
}
impl Global for Relay {}

impl Relay {
    /// Everything queued, capped by count and size (one message always goes).
    fn batch(&self) -> Option<Value> {
        let mut queue = self.queue.borrow_mut();
        let (mut count, mut bytes) = (0, 0);
        while count < BATCH_MESSAGES
            && queue
                .get(count)
                .is_some_and(|(_, size)| count == 0 || bytes + size <= BATCH_BYTES)
        {
            bytes += queue[count].1;
            count += 1;
        }
        (count > 0).then(|| {
            let messages: Vec<_> = queue.drain(..count).map(|(message, _)| message).collect();
            json!({ "messages": messages })
        })
    }
}

pub(super) fn start(cx: &mut App) {
    let (wake, mut woken) = mpsc::unbounded();
    let relay = Relay {
        queue: Rc::default(),
        wake,
        abort: Rc::default(),
    };
    cx.set_global(relay.clone());
    cx.spawn(async move |cx| {
        while woken.next().await.is_some() {
            while let Some(body) = relay.batch() {
                let sent = cx
                    .update(|cx| {
                        Jobs::run(cx, move |client| async move {
                            client.browser_host_cdp(&body).await.is_ok()
                        })
                    })
                    .await;
                if sent != Some(true) {
                    // The host leaves: the stream ends and the reset closes the hosted pages.
                    relay.queue.borrow_mut().clear();
                    if let Some(abort) = relay.abort.borrow_mut().take() {
                        let _ = abort.send(());
                    }
                    break;
                }
            }
        }
    })
    .detach();
}

/// A fresh attachment: the receiver fires when the relay can no longer reach the Agent.
pub(super) fn arm(cx: &App) -> oneshot::Receiver<()> {
    let (send, receive) = oneshot::channel();
    if let Some(relay) = cx.try_global::<Relay>() {
        *relay.abort.borrow_mut() = Some(send);
    }
    receive
}

pub(super) fn clear(cx: &App) {
    if let Some(relay) = cx.try_global::<Relay>() {
        relay.queue.borrow_mut().clear();
    }
}

fn up(cx: &App, tab: Option<&TabId>, message: Value, size: usize) {
    let Some(relay) = cx.try_global::<Relay>() else {
        return;
    };
    // The wrapper around the message counts toward the batch size.
    let size = size + tab.map_or(0, |tab| tab.0.len()) + 32;
    let mut entry = serde_json::Map::new();
    entry.insert("tab".into(), json!(tab.map(|tab| tab.0.as_ref())));
    entry.insert("message".into(), message);
    let mut queue = relay.queue.borrow_mut();
    queue.push_back((Value::Object(entry), size));
    if queue.len() == 1 {
        let _ = relay.wake.unbounded_send(());
    }
}

/// A shell-made event, not tied to a page's own DevTools stream.
pub(super) fn event(cx: &App, message: Value) {
    let size = message.to_string().len();
    up(cx, None, message, size);
}

/// A hosted page's own raw DevTools message; bytes that are not JSON are dropped.
#[cfg(feature = "cef")]
fn raw(cx: &App, tab: &TabId, bytes: &[u8]) {
    if let Ok(message) = serde_json::from_slice(bytes) {
        up(cx, Some(tab), message, bytes.len());
    }
}

/// Browser-level methods never run from the Agent, even though a page session could.
#[cfg(feature = "cef")]
const FENCED: [&str; 6] = [
    "Target.createBrowserContext",
    "Target.createTarget",
    "Target.closeTarget",
    "Target.disposeBrowserContext",
    "Target.attachToTarget",
    "Target.exposeDevToolsProtocol",
];

/// Ids below `RAW_ID_BASE` are the shell's own DevTools requests.
#[cfg(feature = "cef")]
fn allowed(message: &Value) -> bool {
    let own = message["id"]
        .as_f64()
        .is_some_and(|id| id < f64::from(butler_cef_host::osr::RAW_ID_BASE));
    let method = message["method"].as_str().unwrap_or_default();
    !own && !method.starts_with("Browser.") && !FENCED.contains(&method)
}

/// A `cdp` frame of the Agent, sent unchanged to the hosted page it names.
#[cfg(feature = "cef")]
pub(super) fn down(cx: &App, frame: &Value) {
    use crate::ui::browser::model::BrowserState;
    let (Some(tab), Some(message)) = (frame["tab"].as_str(), frame.get("message")) else {
        return;
    };
    if !allowed(message) {
        return;
    }
    let Ok(bytes) = serde_json::to_vec(message) else {
        return;
    };
    let tab = TabId(tab.to_owned().into());
    let model = cx.global::<BrowserState>();
    if model.tab(&tab).is_some_and(|tab| tab.hosted.is_some()) {
        model.engine.devtools_raw(&tab, &bytes);
    }
}

fn info(hosted: &Hosted, method: &str, url: &str, title: &str) -> Value {
    json!({"method":method,"params":{"targetInfo":{
        "targetId":hosted.target,"type":"page","url":url,"title":title}}})
}

/// What a hosted page's engine change means to the Agent.
pub(in crate::ui::browser) fn page_changed(cx: &App, tab: &Tab, change: &PageChange) {
    let Some(hosted) = &tab.hosted else {
        return;
    };
    let message = match change {
        #[cfg(feature = "cef")]
        PageChange::DevToolsRaw(bytes) => return raw(cx, &tab.id, bytes),
        PageChange::Url(url) if *url != tab.url => {
            info(hosted, "Target.targetInfoChanged", url, &tab.title)
        }
        PageChange::Title(title) if *title != tab.title => {
            info(hosted, "Target.targetInfoChanged", &tab.url, title)
        }
        PageChange::Crashed => json!({"method":"Target.targetCrashed","params":{
            "targetId":hosted.target,"status":"crashed","errorCode":0}}),
        _ => return,
    };
    if !hosted.target.is_empty() {
        event(cx, message);
    }
}

pub(in crate::ui::browser) fn closed(cx: &App, tab: &Tab) {
    if let Some(hosted) = tab
        .hosted
        .as_ref()
        .filter(|hosted| !hosted.target.is_empty())
    {
        event(
            cx,
            json!({"method":"Target.targetDestroyed","params":{"targetId":hosted.target}}),
        );
    }
}
