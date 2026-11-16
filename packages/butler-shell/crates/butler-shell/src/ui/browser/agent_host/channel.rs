//! The attach loop: one SSE channel for the life of the app, replaced after it ends.
use super::{pages, relay};
use crate::ui::{
    browser::model::BrowserState,
    source::{agent::Jobs, fetch::sleep},
};
use butler_shell_client::ShellClient;
use futures::{
    StreamExt as _,
    channel::{mpsc, oneshot},
    future::{Either, select},
};
use gpui::App;
use serde_json::Value;
use std::time::Duration;

const RETRY_MIN: Duration = Duration::from_secs(1);
const RETRY_MAX: Duration = Duration::from_secs(30);

enum Item {
    Attached,
    Frame(String, String),
}

pub(super) fn start(cx: &mut App) {
    let (notify, mut changed) = mpsc::unbounded();
    cx.observe_global::<Jobs>(move |_| {
        let _ = notify.unbounded_send(());
    })
    .detach();
    cx.spawn(async move |cx| {
        let mut delay = RETRY_MIN;
        loop {
            while cx.update(|cx| Jobs::client(cx)).is_none() {
                changed.next().await;
            }
            let (send, mut receive) = mpsc::unbounded();
            let attach = cx.update(|cx| {
                let stop = relay::arm(cx);
                Jobs::run(cx, move |client| {
                    read(client, std::process::id(), send, stop)
                })
            });
            while let Some(item) = receive.next().await {
                cx.update(|cx| handle(item, cx));
            }
            let attached = attach.await.unwrap_or(false);
            cx.update(pages::reset);
            if attached {
                delay = RETRY_MIN;
            }
            sleep(cx, delay).await;
            if !attached {
                delay = (delay * 2).min(RETRY_MAX);
            }
        }
    })
    .detach();
}

/// Runs on the agent worker: forwards events until the stream ends, fails or `stop` fires.
/// True when the Agent accepted the attach.
async fn read(
    client: ShellClient,
    pid: u32,
    send: mpsc::UnboundedSender<Item>,
    mut stop: oneshot::Receiver<()>,
) -> bool {
    let Ok(mut events) = client.browser_host_attach(pid).await else {
        return false;
    };
    if send.unbounded_send(Item::Attached).is_err() {
        return true;
    }
    loop {
        match select(events.next(), stop).await {
            Either::Left((Some(Ok((event, data))), rest)) => {
                stop = rest;
                if send.unbounded_send(Item::Frame(event, data)).is_err() {
                    return true;
                }
            }
            _ => return true,
        }
    }
}

fn handle(item: Item, cx: &mut App) {
    let (event, data) = match item {
        Item::Attached => return cx.global::<BrowserState>().publisher.resend(),
        Item::Frame(event, data) => (event, data),
    };
    let Ok(frame) = serde_json::from_str::<Value>(&data) else {
        return;
    };
    match event.as_str() {
        "call" => pages::call(&frame, cx),
        #[cfg(feature = "cef")]
        "cdp" => relay::down(cx, &frame),
        _ => {}
    }
}
