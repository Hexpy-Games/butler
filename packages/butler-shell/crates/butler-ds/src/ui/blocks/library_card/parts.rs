//! The LibraryCard's small parts: the text lines, the tag row, the selection check and the slot a
//! ⋯ menu sits in. GroupTile reuses the meta line and the menu slot.
use gpui::{
    AnyElement, App, ClickEvent, Div, ElementId, FontWeight, InteractiveElement as _,
    IntoElement as _, ParentElement as _, SharedString, StatefulInteractiveElement as _,
    Styled as _, Window, div,
};

use super::Select;
use crate::tokens::{Color, Length, Number};
use crate::ui::Icon;
use crate::ui::context::Ds;
use crate::ui::focus;
use crate::ui::icon::{IconSize, icon};
use crate::ui::tag::{Size as TagSize, Tag};

/// A one-line text row: clipped with an ellipsis, leaving the menu's room at the end.
fn line(ds: &Ds) -> Div {
    div()
        .min_w_0()
        .overflow_hidden()
        .whitespace_nowrap()
        .text_ellipsis()
        .pr(ds.len(Length::ControlHeightMd))
}

pub(super) fn title(text: SharedString, ds: &Ds) -> AnyElement {
    line(ds)
        .text_color(ds.color(Color::TextPrimary))
        .text_size(ds.len(Length::FontSize2))
        .line_height(ds.len(Length::TypoLabelLineHeight))
        .font_weight(FontWeight(ds.number(Number::FontWeightMedium)))
        .child(text)
        .into_any_element()
}

pub(crate) fn meta(text: SharedString, ds: &Ds) -> AnyElement {
    line(ds)
        .text_color(ds.color(Color::TextTertiary))
        .text_size(ds.len(Length::FontSize1))
        .line_height(ds.len(Length::TypoCaptionLineHeight))
        .child(text)
        .into_any_element()
}

/// The item's tags on one line: the first `max`, then "+N" for the rest. None: no line.
pub(super) fn tag_row(
    id: &ElementId,
    tags: &[SharedString],
    max: usize,
    ds: &Ds,
) -> Option<AnyElement> {
    if tags.is_empty() {
        return None;
    }
    let chip = |key: String, text: SharedString| {
        Tag::new((id.clone(), SharedString::from(key)), text).size(TagSize::Sm)
    };
    let shown = tags
        .iter()
        .take(max)
        .enumerate()
        .map(|(index, tag)| chip(format!("tag-{index}"), tag.clone()));
    let rest = tags.len().saturating_sub(max);
    let more = (rest > 0).then(|| chip("tag-more".into(), format!("+{rest}").into()));
    Some(
        div()
            .flex()
            .min_w_0()
            .overflow_hidden()
            .gap(ds.len(Length::SpaceXs))
            .pr(ds.len(Length::ControlHeightMd))
            .children(shown)
            .children(more)
            .into_any_element(),
    )
}

/// The selection circle on the media's top-end corner: shown on hover or focus, always while
/// selecting or checked. A click toggles it and never reaches the card's open.
pub(super) fn check(
    id: &ElementId,
    selected: bool,
    selection_mode: bool,
    group: &SharedString,
    on_select: Select,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let focus_state =
        window.use_keyed_state((id.clone(), "check-focus"), cx, |_, cx| cx.focus_handle());
    let handle = focus::tab_stop(focus_state.read(cx), true);
    let focused = handle.is_focused(window);
    let ds = Ds::get(cx);
    let always = selection_mode || selected || focused;
    let mut el = div()
        .id((id.clone(), "check"))
        .track_focus(&handle)
        .absolute()
        .top(ds.len(Length::SpaceXs))
        .right(ds.len(Length::SpaceXs))
        .flex()
        .items_center()
        .justify_center()
        .size(ds.len(Length::TagHeightSm))
        .rounded(ds.len(Length::RadiusPill))
        .cursor_pointer()
        .text_color(ds.color(Color::NeutralWhite))
        .opacity(if always { 1. } else { 0. })
        // ANIM-MIGRATE(the check fades in over --motion-fast on hover, focus and selection)
        .group_hover_style(group.clone(), |style| style.opacity(1.));
    el = if selected {
        el.bg(ds.color(Color::Accent))
            .child(icon(Icon::CheckIcon, IconSize::Xs, ds))
    } else {
        el.bg(ds.color(Color::Surface))
            .border(ds.len(Length::BorderWidthStrong))
            .border_color(ds.color(Color::LineStrong))
    };
    if focus::visible(ds, focused, false) {
        el = el.shadow(focus::shadows(ds));
    }
    el.on_click(move |event: &ClickEvent, window, cx| {
        cx.stop_propagation();
        on_select(!selected, event, window, cx);
    })
    .into_any_element()
}

/// The ⋯ menu at the end of the title row, never over the media. A click inside it stays its own.
pub(crate) fn menu_slot(id: &ElementId, menu: AnyElement) -> AnyElement {
    div()
        .id((id.clone(), "menu"))
        .absolute()
        .right_0()
        .bottom_0()
        .on_click(|_, _, cx| cx.stop_propagation())
        .child(menu)
        .into_any_element()
}
