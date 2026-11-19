//! Stacked sticky headers (`stickyDepth`, CollapsibleNavGroup.module.css:27-66): a header holds
//! at its scroller's `--nav-sticky-offset`, one row below the sticky headers of the groups around
//! it, until its group scrolls out, and the rows under it clip at its bottom edge. The scroller
//! and the offset come from the enclosing SidebarShell ([`nav_sticky`]); the header is a
//! [`Sticky`] box placed in prepaint.
//!
//! [`nav_sticky`]: crate::ui::blocks::scope::nav_sticky
use gpui::{AnyElement, Hsla, IntoElement as _, ParentElement as _, Pixels, Styled as _, div, px};

use crate::ui::blocks::scope::NavSticky;
use crate::ui::scroll::{ClipUnder, Placement, Sticky};

/// A group's sticky settings.
#[derive(Clone)]
pub(super) struct Pin {
    pub(super) depth: usize,
    pub(super) surface: Option<Hsla>,
}

/// The group with its `header` (filled with `surface`) sticky in `nav`'s scroller, `row` px per
/// depth: it stops with the group's last row, and `content` clips at its bottom edge with the
/// focus-ring room (`room`) left open on the sides and the fold's clip margin (`fold`) below.
pub(super) fn group(
    (header, content): (AnyElement, AnyElement),
    (pin, nav): (&Pin, NavSticky),
    (row, surface, room, fold): (f32, Hsla, Pixels, Pixels),
) -> AnyElement {
    let (block, placed) = (Placement::default(), Placement::default());
    let top = nav.offset + px(pin.depth as f32 * row);
    let header = Sticky::new(&nav.scroll, top, div().w_full().bg(surface).child(header))
        .within(&block)
        .placed(&placed);
    block
        .track(div().w_full().min_w_0())
        .child(header)
        .child(ClipUnder::new(&placed, room, content).bottom(fold))
        .into_any_element()
}
