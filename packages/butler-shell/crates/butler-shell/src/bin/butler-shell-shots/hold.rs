//! `drag-hold` / `drag-release`: a drag that stays pending between commands, so a capture can
//! show the drop feedback (the slot a dragged row opens) before the drop lands.
use super::frame::move_pointer;
use super::{Harness, settle};
use anyhow::Context as _;
use gpui::{MouseButton, MouseDownEvent, MouseUpEvent, Pixels, PlatformInput, Point, point};

/// The point at fractions (`fx`, `fy`) of the next anchor's bounds in `parts`.
fn at<'a>(
    h: &mut Harness,
    parts: &mut impl Iterator<Item = &'a str>,
) -> anyhow::Result<Point<Pixels>> {
    let anchor = parts.next().context("anchor")?;
    let fx: f32 = parts.next().context("fx")?.parse()?;
    let fy: f32 = parts.next().context("fy")?.parse()?;
    let bounds =
        h.cx.debug_bounds(h.handle, anchor)?
            .with_context(|| format!("missing {anchor}"))?;
    Ok(point(
        bounds.left() + bounds.size.width * fx,
        bounds.top() + bounds.size.height * fy,
    ))
}

/// `drag-hold <anchor> <fx> <fy> <target> <fx> <fy>`: with motion on, a left press at fractions
/// of `anchor`'s bounds and moves in steps to fractions of `target`'s, then the button stays
/// down while real time passes for the drop feedback's motion to land.
pub(super) fn drag_hold(h: &mut Harness, arg: &str) -> anyhow::Result<()> {
    h.cx.update(|cx| cx.set_reduce_motion(false));
    let result = (|| {
        settle(&mut h.cx, h.handle);
        let mut parts = arg.split_whitespace();
        let start = at(h, &mut parts)?;
        let end = at(h, &mut parts)?;
        move_pointer(h, h.handle, start, None)?;
        settle(&mut h.cx, h.handle);
        h.cx.update_window(h.handle, |_, w, cx| {
            w.activate();
            w.dispatch_event(
                PlatformInput::MouseDown(MouseDownEvent {
                    button: MouseButton::Left,
                    position: start,
                    modifiers: Default::default(),
                    click_count: 1,
                    first_mouse: false,
                }),
                cx,
            );
        })?;
        h.cx.run_until_parked();
        for step in 1..=8_u8 {
            let fraction = f32::from(step) / 8.;
            let position = start + (end - start) * fraction;
            move_pointer(h, h.handle, position, Some(MouseButton::Left))?;
            h.cx.advance_clock(std::time::Duration::from_millis(16));
            h.cx.run_until_parked();
        }
        std::thread::sleep(std::time::Duration::from_millis(600));
        settle(&mut h.cx, h.handle);
        Ok(())
    })();
    if result.is_err() {
        h.cx.update(|cx| cx.set_reduce_motion(true));
    }
    result
}

/// `drag-release <target> <fx> <fy>`: releases the held drag at fractions of `target`'s bounds,
/// and turns reduced motion back on.
pub(super) fn drag_release(h: &mut Harness, arg: &str) -> anyhow::Result<()> {
    let mut parts = arg.split_whitespace();
    let end = at(h, &mut parts)?;
    h.cx.update_window(h.handle, |_, w, cx| {
        w.dispatch_event(
            PlatformInput::MouseUp(MouseUpEvent {
                button: MouseButton::Left,
                position: end,
                modifiers: Default::default(),
                click_count: 1,
            }),
            cx,
        );
    })?;
    settle(&mut h.cx, h.handle);
    h.cx.update(|cx| cx.set_reduce_motion(true));
    settle(&mut h.cx, h.handle);
    Ok(())
}
