//! Item-aligned positioning (Radix `SelectItemAlignedPosition.position`): the list lays itself
//! over the trigger so the selected item's text sits on the trigger's value, clamped to the
//! window with a 10px margin. With no room above, the list starts at the top margin and scrolls
//! so the selected item is where the trigger is. The Radix formulas, on measured rectangles.
use crate::ui::overlay::place::Rect;

/// `CONTENT_MARGIN`: how near the window's edge the list may come.
pub(super) const MARGIN: f32 = 10.;

/// What is measured of the laid-out list: the border box of the content, the viewport, the item
/// list and the selected row, in window px. `border` and `padding` are the content's own.
#[derive(Clone, Copy, Debug)]
pub(super) struct Measured {
    pub content: Rect,
    pub viewport: Rect,
    pub list: Rect,
    pub item: Rect,
    /// The left of the selected item's text.
    pub text_left: f32,
    pub border: f32,
    pub padding: f32,
}

/// The trigger and the window the list is placed in.
#[derive(Clone, Copy, Debug)]
pub(super) struct Target {
    pub trigger: Rect,
    /// The left of the value inside the trigger.
    pub value_left: f32,
    pub window: (f32, f32),
}

/// Which window edge the list is pinned to.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Pin {
    /// `bottom: 0` of the wrapper: room above the trigger for the whole list.
    Bottom,
    /// `top: 0`: the list starts at the top margin.
    Top,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Geometry {
    pub left: f32,
    pub min_width: f32,
    pub top: f32,
    /// The wrapper's height: the list is never taller (it scrolls).
    pub height: f32,
    pub scroll_top: Option<f32>,
}

fn clamp(value: f32, min: f32, max: f32) -> f32 {
    value.max(min).min(max)
}

/// The wrapper's `left` and `min-width`.
fn horizontal(measured: &Measured, target: &Target) -> (f32, f32) {
    let text_offset = measured.text_left - measured.content.left;
    let left = target.value_left - text_offset;
    let delta = target.trigger.left - left;
    let min_width = target.trigger.width + delta;
    let width = min_width.max(measured.content.width);
    let right_edge = target.window.0 - MARGIN;
    let clamped = clamp(left, MARGIN, MARGIN.max(right_edge - width));
    (clamped, min_width)
}

/// The wrapper's pin, height and the viewport's scroll. The DS viewport has no padding, so the
/// `isFirstItem` and `isLastItem` terms of Radix (`viewportPaddingTop`, `viewportPaddingBottom`)
/// are zero.
fn vertical(measured: &Measured, target: &Target) -> (Pin, f32, Option<f32>, f32) {
    let m = measured;
    let available = target.window.1 - MARGIN * 2.;
    let items_height = m.list.height;
    let full = m.border + m.padding + items_height + m.padding + m.border;
    let min_height = (m.item.height * 5.).min(full);
    let top_to_middle = target.trigger.top + target.trigger.height / 2. - MARGIN;
    let middle_to_bottom = available - top_to_middle;
    let half = m.item.height / 2.;
    let item_top = m.item.top - m.list.top;
    let content_top_to_middle = m.border + m.padding + item_top + half;
    let middle_to_content_bottom = full - content_top_to_middle;
    let viewport_offset_top = m.viewport.top - m.content.top;
    if content_top_to_middle <= top_to_middle {
        let client = m.content.height - 2. * m.border;
        let offset_bottom = client - viewport_offset_top - m.viewport.height;
        let clamped = middle_to_bottom.max(half + offset_bottom + m.border);
        (
            Pin::Bottom,
            content_top_to_middle + clamped,
            None,
            min_height,
        )
    } else {
        let clamped = top_to_middle.max(m.border + viewport_offset_top + half);
        (
            Pin::Top,
            clamped + middle_to_content_bottom,
            Some(content_top_to_middle - top_to_middle + viewport_offset_top),
            min_height,
        )
    }
}

/// Where the list goes.
pub(super) fn place(measured: &Measured, target: &Target) -> Geometry {
    let (left, min_width) = horizontal(measured, target);
    let (pin, height, scroll_top, min_height) = vertical(measured, target);
    let available = target.window.1 - MARGIN * 2.;
    let height = height.max(min_height).min(available);
    let top = match pin {
        Pin::Bottom => target.window.1 - MARGIN - height,
        Pin::Top => MARGIN,
    };
    Geometry {
        left,
        min_width,
        top,
        height,
        scroll_top,
    }
}
