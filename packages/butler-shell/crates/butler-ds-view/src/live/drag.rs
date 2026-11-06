//! The pointer-drag commands of the live harness: a sheet's grabber is pressed with `press`, moved
//! with `dragby` and let go with `release`; `keyboard-inset` feeds the on-screen keyboard's height.
use std::time::Duration;

use anyhow::Context as _;
use gpui::{point, px};

use super::Live;

/// The pointer events of a real drag come about one per frame.
const FRAME_MS: u64 = 16;

impl Live {
    /// `press <n>`: the pointer onto control n (or `@anchor`) and the left button down, held.
    pub(super) fn press(&mut self, arg: &str) -> anyhow::Result<()> {
        let at = self.center(arg)?;
        self.move_to(at)?;
        self.settle();
        self.button(true)?;
        self.wait(100);
        Ok(())
    }

    /// `release`: the left button up, and everything it starts settles.
    pub(super) fn release(&mut self) -> anyhow::Result<()> {
        self.button(false)?;
        self.settle();
        Ok(())
    }

    /// `letgo`: the left button up without settling, the motion it starts still in flight.
    pub(super) fn let_go(&mut self) -> anyhow::Result<()> {
        self.button(false)?;
        self.wait(1);
        Ok(())
    }

    /// `park`: the pointer to the window's top-left corner, so no hover fill is left behind.
    pub(super) fn park(&mut self) -> anyhow::Result<()> {
        self.move_to(point(px(1.), px(1.)))?;
        self.settle();
        Ok(())
    }

    /// `dragby <dy> <ms> [dx]`: the held pointer travels `dy` px down (negative: up) over `ms`,
    /// one move event per 16ms frame, so its speed at the end is `dy / ms`.
    pub(super) fn drag_by(&mut self, arg: &str) -> anyhow::Result<()> {
        let mut parts = arg.split_whitespace();
        let dy: f32 = parts.next().context("dragby <dy> <ms> [dx]")?.parse()?;
        let ms: u64 = parts.next().context("dragby <dy> <ms> [dx]")?.parse()?;
        let dx: f32 = parts.next().map_or(Ok(0.), str::parse)?;
        let steps = (ms / FRAME_MS).max(1);
        #[expect(clippy::cast_precision_loss, reason = "a few dozen steps")]
        let each = (dx / steps as f32, dy / steps as f32);
        let from = self.pointer;
        for step in 1..=steps {
            #[expect(clippy::cast_precision_loss, reason = "a few dozen steps")]
            let n = step as f32;
            self.move_to(point(from.x + px(each.0 * n), from.y + px(each.1 * n)))?;
            self.cx.advance_clock(Duration::from_millis(ms / steps));
            self.cx.run_until_parked();
            let _ = self
                .cx
                .update_window(self.handle, |_, window, _| window.refresh());
        }
        Ok(())
    }

    /// `expect shifted <name> <dy> [tol]`: the anchor is `dy` px lower than `mark` saw it, within
    /// `tol` (1px).
    pub(super) fn shifted(&mut self, arg: &str) -> bool {
        let mut parts = arg.split_whitespace();
        let (Some(name), Some(dy)) = (
            parts.next(),
            parts.next().and_then(|v| v.parse::<f32>().ok()),
        ) else {
            return false;
        };
        let tol: f32 = parts.next().and_then(|v| v.parse().ok()).unwrap_or(1.);
        let (Ok(Some(now)), Some(before)) = (
            self.cx.debug_bounds(self.handle, name),
            self.marks.get(name),
        ) else {
            return false;
        };
        (now.origin.y.as_f32() - before.origin.y.as_f32() - dy).abs() <= tol
    }

    /// `keyboard-inset <px>`: the on-screen keyboard now covers this much of the window's bottom.
    pub(super) fn keyboard_inset(&mut self, arg: &str) -> anyhow::Result<()> {
        let inset: f32 = arg.parse()?;
        self.cx.update(|cx| {
            butler_ds::ui::context::Ds::update(cx, |ds| ds.set_keyboard_inset(inset));
        });
        self.settle();
        Ok(())
    }
}
