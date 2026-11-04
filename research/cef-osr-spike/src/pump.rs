use crate::{log, state::Runtime};
use cef::ImplBrowserHost;
use gpui::*;
use serde_json::json;
use std::time::{Duration, Instant};
pub enum Message {
    Schedule(Instant),
    Visible(bool),
}
pub fn max_delay() -> Duration {
    Duration::from_millis(
        crate::option("--pump-max-ms")
            .map(|v| v.parse().unwrap())
            .unwrap_or(33),
    )
}
pub fn run(rx: async_channel::Receiver<Message>, rt: Runtime, cx: &mut App) {
    cx.spawn(async move |cx| {
        let mut visible = true;
        let mut fallback = Instant::now();
        let mut deadline: Option<Instant> = None;
        let mut scheduled = None;
        let maximum = max_delay();
        loop {
            let message = if let Some(at) = deadline {
                futures_lite::future::or(async { rx.recv().await.ok() }, async {
                    cx.background_executor()
                        .timer(at.saturating_duration_since(Instant::now()))
                        .await;
                    None
                })
                .await
            } else {
                rx.recv().await.ok()
            };
            match message {
                Some(Message::Schedule(at)) => {
                    if crate::begin_frame::mode() == Some("change-pump") { rt.shared.borrow().want_frame(); }
                    scheduled = Some(at);
                    deadline = Some(if visible { at.min(fallback) } else { at });
                }
                Some(Message::Visible(value)) => {
                    visible = value;
                    rt.shared.borrow_mut().hidden = !value;
                    if value {
                        rt.shared.borrow().want_frame();
                    }
                    if let Some(host) = rt.host() {
                        host.was_hidden(i32::from(!value));
                        if value {
                            host.invalidate(cef::PaintElementType::VIEW);
                        }
                    }
                    if !value {
                        rt.release_frames();
                    }
                    // Cancel only the periodic fallback. Explicit CEF requests still run.
                    fallback = Instant::now();
                    deadline = if value { Some(fallback) } else { scheduled };
                    log(
                        "pump_visibility",
                        json!({"visible":value,"pumps":rt.shared.borrow().pumps,"frames":rt.shared.borrow().frames,"presentation":crate::presentation::snapshot()}),
                    );
                }
                None => {
                    if rt.shared.borrow().closed {
                        break;
                    }
                    if crate::CEF_STARTED.load(std::sync::atomic::Ordering::SeqCst) {
                        cx.update(|_| {
                            let count = {
                                let mut s = rt.shared.borrow_mut();
                                s.pumps += 1;
                                s.pumps
                            };
                            if count <= 5 {
                                log("pump_dispatch", json!(count));
                            }
                            cef::do_message_loop_work();
                        });
                    }
                    scheduled = None;
                    fallback = Instant::now() + maximum;
                    deadline = visible.then_some(fallback);
                }
            }
        }
    })
    .detach();
}
