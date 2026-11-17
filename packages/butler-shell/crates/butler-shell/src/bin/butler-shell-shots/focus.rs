//! Keyboard focus ring commands of the live harness.
use super::{Harness, settle};
use anyhow::{Context as _, ensure};
use gpui::px;

/// `expect-focus-ring <anchor>`: the focused control painted a keyboard ring (the DS publishes its
/// box only then) and sits inside the anchor. `expect-no-focus-ring`: it did not (a pointer focus).
pub(super) fn expect_ring(h: &mut Harness, command: &str, anchor: &str) -> anyhow::Result<()> {
    settle(&mut h.cx, h.handle);
    let ring = h.cx.update_window(h.handle, |_, window, cx| {
        let focused = window.focused(cx)?;
        butler_ds::ui::focus::published(cx, &focused)
    })?;
    if command == "expect-no-focus-ring" {
        ensure!(ring.is_none(), "a focus ring is shown");
        return Ok(());
    }
    let ring = ring.context("the focused control shows no focus ring")?;
    let outer =
        h.cx.debug_bounds(h.handle, anchor)?
            .with_context(|| format!("missing {anchor}"))?;
    let slack = px(0.5);
    let inside = ring.bounds.left() + slack >= outer.left()
        && ring.bounds.top() + slack >= outer.top()
        && ring.bounds.right() <= outer.right() + slack
        && ring.bounds.bottom() <= outer.bottom() + slack;
    ensure!(
        ring.ring > px(0.) && inside,
        "ring box {:?} not in {anchor} {outer:?}",
        ring.bounds
    );
    Ok(())
}
