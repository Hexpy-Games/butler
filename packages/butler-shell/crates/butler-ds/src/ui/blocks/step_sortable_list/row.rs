//! One row (`StepSortableRow.tsx`): `[grip] [number or status glyph] [title (more) ........ meta]
//! / [caption] [⋯]`; the meta, then `more`, wrap before the title truncates. A card dragged out of
//! an open 묶음 stays dimmed in place.
use gpui::{
    AnyElement, App, InteractiveElement as _, IntoElement as _, MouseButton, ParentElement as _,
    Styled as _, Window, div, px,
};

use super::grip::{Grip, control_side, grip};
use super::{Env, StepSortableItem, StepSortableRowContext, StepSortableRowSlots, sub};
use crate::tokens::Length;
use crate::ui::blocks::measure;
use crate::ui::context::Ds;
use crate::ui::icon_slot::{IconSlot, SlotSize, SlotTone};
use crate::ui::typo::{Tone, Typo, Wrap};

/// `@container step-row (width < 28rem)`.
const NARROW_REM: f32 = 28.; // DS: StepSortableList.module.css:140
/// Opacity of a dimmed (lifted-in-place) row.
const DIMMED: f32 = 0.5; // DS: StepSortableList.module.css:157

pub(super) struct RowArgs<'a> {
    pub item: &'a StepSortableItem,
    pub ctx: StepSortableRowContext,
    /// The grip's drag: one item, or the whole step (a collapsed 묶음). `None`: no grip (pinned).
    pub grip: Option<Grip>,
    /// Show the marker (an open 묶음 shows the step number on its first card only; the others
    /// keep its room).
    pub marker: bool,
    /// The row stays dimmed in place while its item is dragged out.
    pub dim: bool,
}

/// The title line: the title first, then `more` (the title truncates, `more` never does), and the
/// meta at the line's end, wrapping to its own line before the title truncates.
fn title_line(slots: &mut StepSortableRowSlots, done: bool, gap: gpui::Pixels) -> AnyElement {
    let mut title = Typo::body(slots.title.clone()).truncate();
    if done {
        title = title.tone(Tone::Secondary);
    }
    let mut block = div()
        .flex()
        .flex_auto()
        .flex_wrap()
        .items_baseline()
        .min_w_0()
        .gap_x(gap)
        .child(div().flex_initial().min_w_0().child(title));
    if let Some(more) = slots.more.take() {
        let more = Typo::body(more).tone(Tone::Tertiary).wrap(Wrap::Nowrap);
        block = block.child(div().flex_none().child(more));
    }
    let mut line = div()
        .flex()
        .flex_wrap()
        .items_center()
        .min_w_0()
        .gap_x(gap)
        .child(block);
    if let Some(meta) = slots.meta.take() {
        let meta = Typo::caption(meta)
            .tone(Tone::Tertiary)
            .tabular()
            .wrap(Wrap::Nowrap);
        line = line.child(div().flex_none().ml_auto().child(meta));
    }
    line.into_any_element()
}

/// The title line, then the caption under it.
fn text_column(
    slots: &mut StepSortableRowSlots,
    done: bool,
    gap: gpui::Pixels,
    line_gap: gpui::Pixels,
) -> gpui::Div {
    let mut text = div()
        .flex()
        .flex_col()
        .flex_auto()
        .min_w_0()
        .gap(gap)
        .child(title_line(slots, done, line_gap));
    if let Some(caption) = slots.caption.take() {
        let tone = if done {
            Tone::Tertiary
        } else {
            Tone::Secondary
        };
        text = text.child(Typo::caption(caption).tone(tone).truncate());
    }
    text
}

/// The trailing control, or its room (statuses line up down the list).
fn trailing_control(
    control: Option<AnyElement>,
    lifted: bool,
    narrow: bool,
    side: gpui::Pixels,
) -> AnyElement {
    match control.filter(|_| !lifted) {
        Some(control) => div()
            .flex()
            .items_center()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(control)
            .into_any_element(),
        None if narrow => div().into_any_element(),
        None => div().w(side).into_any_element(),
    }
}

pub(super) fn row(env: &Env, args: RowArgs<'_>, window: &mut Window, cx: &mut App) -> AnyElement {
    let RowArgs {
        item,
        ctx,
        grip: grip_args,
        marker,
        dim,
    } = args;
    let (side, line, xs, sm) = {
        let ds = Ds::get(cx);
        (
            control_side(ds),
            ds.len(Length::TypoBodyLineHeight),
            ds.len(Length::SpaceXs),
            ds.len(Length::SpaceSm),
        )
    };
    let (size, recorder) = measure::track(sub(&env.id, "row", &item.id), window, cx);
    let narrow = size.width > px(0.) && size.width < window.rem_size() * NARROW_REM;
    let mut slots = (env.render_item)(item, &ctx, window, cx);
    // A cell of the row; a dimmed row fades everything but its grip.
    let cell = |grow: bool| {
        let cell = div().flex();
        let cell = if grow {
            cell.flex_auto().min_w_0()
        } else {
            cell.flex_none()
        };
        if dim { cell.opacity(DIMMED) } else { cell }
    };

    // The leading grip slot: as tall as the title line, pulled back by `--space-xs`.
    let grip_el = grip_args.and_then(|g| grip(env, &g, ctx.lifted, window, cx));
    let lead = div()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .w(side)
        .h(line)
        .ml(-xs)
        .children(grip_el);
    let marker_slot = IconSlot::new()
        .size(SlotSize::Md)
        .min_line()
        .tone(SlotTone::Tertiary)
        .children(marker.then(|| slots.marker.take()).flatten());

    let text = text_column(&mut slots, item.done, xs, sm);
    let trailing = trailing_control(slots.trailing.take(), ctx.lifted, narrow, side);

    div()
        .relative()
        .flex()
        .min_w_0()
        .gap(sm)
        .items_start()
        .child(lead)
        .child(cell(false).child(marker_slot))
        .child(cell(true).child(text))
        .child(cell(false).self_center().child(trailing))
        .child(recorder)
        .into_any_element()
}
