use crate::{harness::Handle, log, state::Runtime};
use gpui::*;
use serde_json::json;
use std::time::{Duration, Instant};
pub async fn run(h: Handle, rt: Runtime, cx: &mut AsyncApp) {
    let start = Instant::now();
    while !rt.shared.borrow().first_paint {
        assert!(start.elapsed() < Duration::from_secs(15), "No first frame");
        cx.background_executor()
            .timer(Duration::from_millis(50))
            .await;
    }
    let host = rt.host().unwrap();
    for mode in ["idle", "scroll", "animate", "video"]
        .into_iter()
        .filter(|m| crate::option("--modes").is_none_or(|v| v.split(',').any(|x| x == *m)))
    {
        rt.cdp
            .eval(&host, &format!("window.setMode({})", json!(mode)), false)
            .await;
        cx.background_executor()
            .timer(Duration::from_secs(if mode == "idle" { 60 } else { 2 }))
            .await;
        let before=rt.cdp.eval(&host,"window.rafCount=0;window.__rafEpoch=performance.now();({videoFrames:document.querySelector('video').getVideoPlaybackQuality().totalVideoFrames,videoTime:document.querySelector('video').currentTime})",false).await;
        let seconds = 20;
        let (frames, pumps) = {
            let mut s = rt.shared.borrow_mut();
            s.copies_ms.clear();
            s.latencies_ms.clear();
            s.begin_frame_to_frame_ms.clear();
            (
                s.begin_frames,
                s.late_frames,
                s.unsolicited_frames,
                s.overwritten_in_flight,
                s.resurrected,
            ) = (0, 0, 0, 0, 0);
            (s.frames, s.pumps)
        };
        let presented = crate::presentation::snapshot()["presented"]
            .as_u64()
            .unwrap();
        crate::presentation::latency();
        let start = Instant::now();
        let b = rt.shared.borrow().bounds;
        log(
            "metric_begin",
            json!({"mode":mode,"seconds":seconds,"software":crate::flag("--software"),"window":if crate::flag("--large"){[1600,1000]}else{[1200,800]},"viewport":[f32::from(b.size.width),f32::from(b.size.height)],"scale":rt.shared.borrow().scale,"pump_max_ms":crate::pump::max_delay().as_millis()}),
        );
        if mode == "scroll" {
            scroll(h, &rt, cx, seconds).await;
        } else {
            cx.background_executor()
                .timer(Duration::from_secs(seconds))
                .await;
        }
        let elapsed = start.elapsed().as_secs_f64();
        let presentation = crate::presentation::snapshot();
        let shown = presentation["presented"].as_u64().unwrap() - presented;
        let (count, pumps, copy, latency) = {
            let mut s = rt.shared.borrow_mut();
            (
                s.frames - frames,
                s.pumps - pumps,
                stats(&mut s.copies_ms),
                stats(&mut s.latencies_ms),
            )
        };
        let display_latency = crate::presentation::latency();
        let page=rt.cdp.eval(&host,"({rafCount,rafElapsed:(performance.now()-window.__rafEpoch)/1000,mode,scrollY,width:innerWidth,height:innerHeight,scale:devicePixelRatio,video:{error:document.querySelector('video').error?.message,paused:document.querySelector('video').paused,time:document.querySelector('video').currentTime,frames:document.querySelector('video').getVideoPlaybackQuality().totalVideoFrames}})",false).await;
        let correct = page["mode"] == mode
            && page["width"] == f32::from(b.size.width) as u64
            && page["height"] == f32::from(b.size.height) as u64
            && page["scale"] == 2
            && (mode != "video"
                || page["video"]["paused"] == false
                    && page["video"]["frames"].as_u64().unwrap()
                        > before["videoFrames"].as_u64().unwrap());
        log(
            "metric_end",
            json!({"mode":mode,"software":crate::flag("--software"),"large":crate::flag("--large"),"elapsed_s":elapsed,"callback_frames":count,"callback_fps":count as f64/elapsed,"presented_frames":shown,"presented_fps":shown as f64/elapsed,"unpresented_net":count as i64-shown as i64,"pump_calls":pumps,"pump_hz":pumps as f64/elapsed,"copy_ms":copy,"input_to_callback_ms":latency,"input_to_present_ms":display_latency,"page":page,"before":before,"raf_fps":page["rafCount"].as_f64().unwrap_or(0.)/page["rafElapsed"].as_f64().unwrap_or(elapsed),"correct":correct,"presentation":presentation,"pacing":crate::begin_frame::snapshot(&mut rt.shared.borrow_mut()),"view_pool":rt.shared.borrow().view_pool.snapshot(),"popup_pool":rt.shared.borrow().popup_pool.snapshot()}),
        );
    }
    rt.close();
}
async fn scroll(h: Handle, rt: &Runtime, cx: &mut AsyncApp, seconds: u64) {
    let start = Instant::now();
    let mut count = 0;
    while start.elapsed() < Duration::from_secs(seconds) {
        let b = rt.shared.borrow().bounds;
        let sign = if (count / 90) % 2 == 0 { -1. } else { 1. };
        let handle: AnyWindowHandle = h.into();
        let _ = handle.update(cx, |_, w, cx| {
            w.dispatch_event(
                PlatformInput::ScrollWheel(ScrollWheelEvent {
                    position: b.center(),
                    delta: ScrollDelta::Pixels(point(px(0.), px(sign * 12.))),
                    modifiers: Modifiers::default(),
                    touch_phase: TouchPhase::Moved,
                }),
                cx,
            );
        });
        count += 1;
        cx.background_executor()
            .timer(Duration::from_millis(16))
            .await;
    }
}
pub fn stats(v: &mut [f64]) -> serde_json::Value {
    v.sort_by(f64::total_cmp);
    if v.is_empty() {
        return json!({"count":0});
    }
    json!({"count":v.len(),"p50":v[v.len()/2],"p95":v[(v.len()*95/100).min(v.len()-1)],"max":v[v.len()-1]})
}
