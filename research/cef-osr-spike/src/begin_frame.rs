//! External BeginFrame pacing for zero-copy frames (`--begin-frames tick|change|change-pump`).
//! Chromium writes into its capture buffers only while running a BeginFrame we send, and it returns
//! the previous buffer to its pool when it captures a newer frame, possibly before that frame reaches
//! us. So a BeginFrame goes out only once the last one's frame has arrived (or `WAIT` has passed) and
//! gpui's GPU work no longer reads any replaced frame. CEF 156 has no "needs a frame" signal, so the
//! `change` modes send one after events that may change the page; `tick` sends one per display interval.
use crate::state::{Runtime, Shared};
use cef::ImplBrowserHost;
use gpui::*;
use serde_json::json;
use std::time::{Duration, Instant};
const INTERVAL: Duration = Duration::from_micros(16_667);
/// How long a BeginFrame's frame may take before we assume the page had nothing new.
pub const WAIT: Duration = Duration::from_millis(50);
pub fn mode() -> Option<&'static str> {
    static MODE: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    MODE.get_or_init(|| crate::option("--begin-frames"))
        .as_deref()
}
pub fn run(rt: Runtime, rx: async_channel::Receiver<()>, cx: &mut App) {
    let tick = mode() == Some("tick");
    cx.spawn(async move |cx| {
        let mut last = Instant::now() - INTERVAL;
        loop {
            if (!tick || rt.shared.borrow().hidden) && rx.recv().await.is_err() {
                break;
            }
            loop {
                let wait = {
                    let s = rt.shared.borrow();
                    let frame = s.awaiting.map_or(Duration::ZERO, |at| {
                        (at + WAIT).saturating_duration_since(Instant::now())
                    });
                    frame.max((last + INTERVAL).saturating_duration_since(Instant::now()))
                };
                if wait.is_zero() {
                    break;
                }
                futures_lite::future::or(
                    async {
                        rx.recv().await.ok();
                    },
                    async {
                        cx.background_executor().timer(wait).await;
                    },
                )
                .await;
            }
            // gpui's completion handler wakes us when its GPU work stops reading a frame.
            while !rt.shared.borrow_mut().retired_idle() {
                if rx.recv().await.is_err() {
                    return;
                }
            }
            while rx.try_recv().is_ok() {}
            let mut s = rt.shared.borrow_mut();
            if s.closed {
                break;
            }
            if s.hidden || s.awaiting.is_some_and(|at| at.elapsed() < WAIT) {
                continue;
            }
            drop(s);
            if let Some(host) = rt.host() {
                host.send_external_begin_frame();
                let mut s = rt.shared.borrow_mut();
                s.begin_frames += 1;
                s.awaiting = Some(Instant::now());
                last = Instant::now();
            }
        }
    })
    .detach();
}
/// Records a zero-copy view frame: which Chromium buffer it is, whether it rewrote a buffer gpui was
/// still reading, and how long it took after the BeginFrame that asked for it.
pub fn received(s: &mut Shared, frame: &core_video::pixel_buffer::CVPixelBuffer, surface: u32) {
    let _ = s.retired_idle();
    if s.retired.iter().any(|(_, id)| *id == surface) {
        s.overwritten_in_flight += 1;
    }
    if s.frame.is_some() && s.frame_surface == surface {
        s.resurrected += 1;
    }
    if let Some(old) = s.frame.take() {
        let id = s.frame_surface;
        s.retired.push((old, id));
    }
    s.frame = Some(frame.clone());
    s.frame_surface = surface;
    match s.awaiting.take() {
        Some(at) => {
            s.begin_frame_to_frame_ms
                .push(at.elapsed().as_secs_f64() * 1000.);
            if at.elapsed() >= WAIT {
                s.late_frames += 1;
            }
        }
        None => s.unsolicited_frames += 1,
    }
}
pub fn snapshot(s: &mut Shared) -> serde_json::Value {
    json!({"mode":mode(),"begin_frames":s.begin_frames,"begin_frame_to_frame_ms":crate::perf::stats(&mut s.begin_frame_to_frame_ms),"late_frames":s.late_frames,"unsolicited_frames":s.unsolicited_frames,"overwritten_in_flight":s.overwritten_in_flight,"resurrected":s.resurrected})
}
