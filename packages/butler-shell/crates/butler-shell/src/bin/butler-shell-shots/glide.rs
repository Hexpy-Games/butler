//! `expect-click-glide` and `glide-layout`: a real click, then frames drawn only on request,
//! sampling anchors while a layout motion runs.
use super::frame::{find_anchor, move_pointer};
use super::{Harness, settle};
use anyhow::{Context as _, ensure};
use gpui::{MouseButton, MouseDownEvent, MouseUpEvent, PlatformInput};
use std::path::Path;

/// `expect-click-glide <click-anchor> <anchor>`: with motion on, a real click on the first
/// anchor, then frames on a stepped animation clock (16 ms each, timers alongside). A frame is
/// drawn only when something requested it (`simulate_next_frame`), as the display link does,
/// and nothing may be requested at rest, so the motion must drive its own frames. The second
/// anchor's height must move one way and take values between its first and last. The clock
/// and reduced motion are restored on every exit.
pub(super) fn expect_click_glide(h: &mut Harness, arg: &str) -> anyhow::Result<()> {
    let (click, anchor) = arg
        .split_once(' ')
        .context("expect-click-glide <click-anchor> <anchor>")?;
    let sampled = with_motion(h, |h| click_samples(h, click, |h| height(h, anchor)));
    let heights: Vec<f32> = sampled?.into_iter().map(|(_, height)| height).collect();
    println!("LIVE HEIGHTS {anchor} {heights:?}");
    let (first, last) = (heights[0], heights[heights.len() - 1]);
    let way = last - first;
    ensure!(way.abs() > 1., "{anchor} did not change: {heights:?}");
    ensure!(
        heights
            .windows(2)
            .all(|w| (w[1] - w[0]) * way.signum() > -0.01),
        "{anchor} did not move one way: {heights:?}"
    );
    let between = heights
        .iter()
        .filter(|&&v| (v - first).abs() > 0.5 && (v - last).abs() > 0.5)
        .count();
    ensure!(between >= 3, "{anchor} jumped: {heights:?}");
    Ok(())
}

/// Runs `f` with reduced motion off, then restores the clock and reduced motion on every exit.
fn with_motion<T>(
    h: &mut Harness,
    f: impl FnOnce(&mut Harness) -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    h.cx.update(|cx| cx.set_reduce_motion(false));
    let result = f(h);
    gpui::set_animation_clock(None);
    h.cx.update(|cx| cx.set_reduce_motion(true));
    settle(&mut h.cx, h.handle);
    result
}

fn height(h: &mut Harness, anchor: &str) -> anyhow::Result<f32> {
    let bounds = h.cx.debug_bounds(h.handle, anchor)?;
    Ok(f32::from(
        bounds.context("missing measured anchor")?.size.height,
    ))
}

/// `glide-layout <click-anchor> <name> <anchor>...`: the same click and stepped frames, writing
/// `<name>.glide.json`: per frame (0 is before the click) the frame's pending-request count and
/// each anchor's `[x, y, w, h]` (`null` when absent). Nothing may be requested after frame 40.
pub(super) fn glide_layout(h: &mut Harness, dir: &Path, arg: &str) -> anyhow::Result<()> {
    let mut words = arg.split_whitespace();
    let (click, name) = (
        words
            .next()
            .context("glide-layout <click-anchor> <name> <anchor>...")?,
        words
            .next()
            .context("glide-layout <click-anchor> <name> <anchor>...")?,
    );
    let anchors: Vec<&str> = words.collect();
    let frames = with_motion(h, |h| {
        click_samples(h, click, |h| {
            let mut found = serde_json::Map::new();
            for anchor in &anchors {
                let bounds = h.cx.debug_bounds(h.handle, anchor)?;
                found.insert(
                    (*anchor).to_owned(),
                    bounds.map_or(serde_json::Value::Null, |b| {
                        serde_json::json!([
                            b.origin.x.as_f32(),
                            b.origin.y.as_f32(),
                            b.size.width.as_f32(),
                            b.size.height.as_f32()
                        ])
                    }),
                );
            }
            Ok(found)
        })
    })?;
    let last = frames.last().map_or(0, |(pending, _)| *pending);
    ensure!(last == 0, "{last} frames still requested after frame 40");
    let report: Vec<_> = frames
        .into_iter()
        .enumerate()
        .map(|(frame, (pending, anchors))| {
            serde_json::json!({"frame": frame, "pending": pending, "anchors": anchors})
        })
        .collect();
    std::fs::write(
        dir.join(format!("{name}.glide.json")),
        serde_json::to_vec_pretty(&report)?,
    )?;
    Ok(())
}

/// `sample` after the settle (frame 0, nothing pending) and after each of 40 requested frames,
/// with the number of frames still requested after each.
fn click_samples<T>(
    h: &mut Harness,
    click: &str,
    mut sample: impl FnMut(&mut Harness) -> anyhow::Result<T>,
) -> anyhow::Result<Vec<(usize, T)>> {
    settle(&mut h.cx, h.handle);
    let (handle, target) = find_anchor(h, click)?.context("missing click target")?;
    move_pointer(h, handle, target.center(), None)?;
    settle(&mut h.cx, h.handle);
    // A display link would already have delivered the frames requested while settling; at
    // rest nothing may ask for more, so after the click only the motion's requests draw.
    let mut pending = 0;
    for _ in 0..10 {
        pending =
            h.cx.update_window(h.handle, |_, window, cx| window.simulate_next_frame(cx))?;
        h.cx.run_until_parked();
        if pending == 0 {
            break;
        }
    }
    ensure!(pending == 0, "{pending} frames still requested at rest");
    let mut samples = vec![(0, sample(h)?)];
    let start = gpui::animation_time_ms();
    gpui::set_animation_clock(Some(start));
    let down = MouseDownEvent {
        button: MouseButton::Left,
        position: target.center(),
        modifiers: Default::default(),
        click_count: 1,
        first_mouse: false,
    };
    let up = MouseUpEvent {
        button: MouseButton::Left,
        position: target.center(),
        modifiers: Default::default(),
        click_count: 1,
    };
    h.cx.update_window(handle, |_, w, cx| {
        w.dispatch_event(PlatformInput::MouseDown(down), cx);
        w.dispatch_event(PlatformInput::MouseUp(up), cx);
    })?;
    for frame in 1..=40_u32 {
        gpui::set_animation_clock(Some(start.wrapping_add(frame * 16)));
        h.cx.advance_clock(std::time::Duration::from_millis(16));
        h.cx.run_until_parked();
        let pending =
            h.cx.update_window(h.handle, |_, window, cx| window.simulate_next_frame(cx))?;
        h.cx.run_until_parked();
        samples.push((pending, sample(h)?));
    }
    Ok(samples)
}
