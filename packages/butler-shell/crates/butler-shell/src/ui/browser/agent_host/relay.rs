//! Raw DevTools messages between hosted pages and the Agent; up in order, one request at a time.
#[cfg(feature = "cef")]
use super::Holder;
use super::Hosted;
#[cfg(feature = "cef")]
use crate::ui::browser::engine::PageCommand;
use crate::ui::{
    browser::{
        engine::{PageChange, PageEngine, TabId},
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
use std::{
    cell::{Cell, RefCell},
    collections::VecDeque,
    rc::Rc,
};

const BATCH_MESSAGES: usize = 256;
const BATCH_BYTES: usize = 8 << 20;

#[derive(Clone)]
struct Relay {
    queue: Rc<RefCell<VecDeque<(Value, usize)>>>,
    wake: mpsc::UnboundedSender<()>,
    /// Ends the attach stream of the current attachment.
    abort: Rc<RefCell<Option<oneshot::Sender<()>>>>,
    /// Counts attachments; a failure only ends the attachment it was sent on.
    generation: Rc<Cell<u64>>,
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
        generation: Rc::default(),
    };
    cx.set_global(relay.clone());
    cx.spawn(async move |cx| {
        while woken.next().await.is_some() {
            while let Some(body) = relay.batch() {
                let generation = relay.generation.get();
                let sent = cx
                    .update(|cx| {
                        Jobs::run(cx, move |client| async move {
                            client.browser_host_cdp(&body).await.is_ok()
                        })
                    })
                    .await;
                if sent != Some(true) {
                    if relay.generation.get() != generation {
                        // The attachment this batch belonged to is already gone.
                        break;
                    }
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
        relay.generation.set(relay.generation.get() + 1);
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

/// A hosted page's own raw DevTools message; bytes that are not JSON are dropped. The success
/// reply to the Agent's `Runtime.runIfWaitingForDebugger` on the page itself, the last step of
/// its setup, lets the page's held loads go: the URL its main frame tried meanwhile loads now,
/// if it is a web address.
#[cfg(feature = "cef")]
fn raw(cx: &App, tab: &TabId, hosted: &mut Hosted, engine: &mut dyn PageEngine, bytes: &[u8]) {
    let Ok(message) = serde_json::from_slice::<Value>(bytes) else {
        return;
    };
    let reply = message.get("sessionId").is_none() && hosted.start.as_ref() == Some(&message["id"]);
    if reply {
        hosted.start = None;
    }
    let started = reply && message.get("result").is_some();
    up(cx, Some(tab), message, bytes.len());
    if started
        && let Some(url) = engine.release_loads(tab)
        && let Some(url) = crate::ui::browser::address::web_url(&url)
    {
        engine.command(tab, PageCommand::Load(url));
    }
}

/// What the Agent's executor turns on for a page it drives (butler-runtime `headless/targets.rs`
/// `setup_page`) that would otherwise keep intercepting after the page is the user's: undone here
/// because the session cannot be detached. The list mirrors `setup_page` in full: interception,
/// then the domains (which also stop the page looking automated and the events flowing). Turning
/// auto-attach off detaches every child session, which ends their own interception.
#[cfg(feature = "cef")]
pub(super) fn release(engine: &dyn PageEngine, tab: &TabId) {
    const MESSAGES: [(&str, &str); 8] = [
        ("Fetch.disable", "{}"),
        ("Page.setInterceptFileChooserDialog", r#"{"enabled":false}"#),
        ("Emulation.clearDeviceMetricsOverride", "{}"),
        ("Emulation.setFocusEmulationEnabled", r#"{"enabled":false}"#),
        (
            "Target.setAutoAttach",
            r#"{"autoAttach":false,"waitForDebuggerOnStart":false,"flatten":true}"#,
        ),
        ("Runtime.disable", "{}"),
        ("Network.disable", "{}"),
        ("Page.disable", "{}"),
    ];
    for (offset, (method, params)) in (1..).zip(MESSAGES) {
        let id = butler_cef_host::osr::RAW_ID_BASE + offset;
        let message = format!(r#"{{"id":{id},"method":"{method}","params":{params}}}"#);
        engine.devtools_raw(tab, message.as_bytes());
    }
}

/// What the Agent may send down. A page session can otherwise reach the browser and every
/// other page (`Browser.*`, `Target.attachToBrowserTarget`, `Target.getTargets`,
/// `Target.sendMessageToTarget`, ...), so of the Target domain only auto-attach (the page's own
/// frames and workers) and detach pass. Ids below `RAW_ID_BASE` are the shell's own requests.
#[cfg(feature = "cef")]
fn allowed(message: &Value) -> bool {
    let own = message["id"]
        .as_f64()
        .is_some_and(|id| id < f64::from(butler_cef_host::osr::RAW_ID_BASE));
    let method = message["method"].as_str().unwrap_or_default();
    !own && !method.starts_with("Browser.")
        && (!method.starts_with("Target.")
            || matches!(method, "Target.setAutoAttach" | "Target.detachFromTarget"))
}

#[cfg(feature = "cef")]
fn fetch_reply(message: &Value) -> bool {
    message["method"] == "Fetch.failRequest"
        || (message["method"] == "Fetch.continueRequest"
            && message["params"]
                .as_object()
                .is_some_and(|params| params.keys().all(|key| key == "requestId")))
}

/// A `cdp` frame of the Agent, sent unchanged to the hosted page it names. A
/// `Runtime.runIfWaitingForDebugger` on the page itself (a frame's session carries its
/// `sessionId`) lets the page run: its id is kept until the reply.
#[cfg(feature = "cef")]
pub(super) fn down(cx: &mut App, frame: &Value) {
    use crate::ui::browser::model::BrowserState;
    use gpui::BorrowAppContext as _;
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
    let refused = cx.update_global::<BrowserState, _>(|model, _| {
        let hosted = model
            .tabs
            .iter_mut()
            .find(|candidate| candidate.id == tab)
            .and_then(|candidate| candidate.hosted.as_mut())?;
        // The user holds the page: only Fetch replies that cannot alter a request pass.
        if hosted.holder == Holder::User && !fetch_reply(message) {
            return Some(());
        }
        if message["method"] == "Runtime.runIfWaitingForDebugger"
            && message.get("sessionId").is_none()
        {
            hosted.start = Some(message["id"].clone());
        }
        model.engine.devtools_raw(&tab, &bytes);
        None
    });
    if refused.is_some() {
        let mut reply = json!({"id": message["id"],
            "error": {"code": -32000, "message": "user_control"}});
        if let Some(session) = message.get("sessionId") {
            reply["sessionId"] = session.clone();
        }
        let size = reply.to_string().len();
        up(cx, Some(&tab), reply, size);
    }
}

fn info(hosted: &Hosted, method: &str, url: &str, title: &str) -> Value {
    json!({"method":method,"params":{"targetInfo":{
        "targetId":hosted.target,"type":"page","url":url,"title":title}}})
}

/// What a hosted page's engine change means to the Agent.
pub(in crate::ui::browser) fn page_changed(
    cx: &App,
    tab: &mut Tab,
    #[cfg_attr(
        not(feature = "cef"),
        expect(
            unused_variables,
            reason = "only raw DevTools messages reach the engine"
        )
    )]
    engine: &mut dyn PageEngine,
    change: &PageChange,
) {
    let Some(hosted) = tab.hosted.as_mut() else {
        return;
    };
    let message = match change {
        #[cfg(feature = "cef")]
        PageChange::DevToolsRaw(bytes) => return raw(cx, &tab.id, hosted, engine, bytes),
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
