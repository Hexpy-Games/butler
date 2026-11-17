//! `expect-click-glide`: a real click, then frames drawn only on request, sampling an anchor's
//! height while a layout motion runs.
use super::frame::{find_anchor, move_pointer};
use super::{Harness, settle};
use anyhow::{Context as _, ensure};
use gpui::{MouseButton, MouseDownEvent, MouseUpEvent, PlatformInput};

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
    h.cx.update(|cx| cx.set_reduce_motion(false));
    let sampled = click_samples(h, click, anchor);
    gpui::set_animation_clock(None);
    h.cx.update(|cx| cx.set_reduce_motion(true));
    settle(&mut h.cx, h.handle);
    let heights = sampled?;
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

/// The anchor's height before a click on `click` and after each of 40 requested frames.
fn click_samples(h: &mut Harness, click: &str, anchor: &str) -> anyhow::Result<Vec<f32>> {
    settle(&mut h.cx, h.handle);
    let height = |h: &mut Harness| -> anyhow::Result<f32> {
        let bounds = h.cx.debug_bounds(h.handle, anchor)?;
        Ok(f32::from(
            bounds.context("missing measured anchor")?.size.height,
        ))
    };
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
    let mut heights = vec![height(h)?];
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
    for frame in 1..=40 {
        gpui::set_animation_clock(Some(start.wrapping_add(frame * 16)));
        h.cx.advance_clock(std::time::Duration::from_millis(16));
        h.cx.run_until_parked();
        h.cx.update_window(h.handle, |_, window, cx| {
            window.simulate_next_frame(cx);
        })?;
        h.cx.run_until_parked();
        heights.push(height(h)?);
    }
    Ok(heights)
}
