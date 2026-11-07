//! The palette's pieces (CommandPanel.tsx, CommandPanel.module.css): the input row with its bare
//! editor and close button, the key handling, the scrolling results and the option rows.
use std::cell::RefCell;
use std::ops::Range;
use std::rc::Rc;

use gpui::{
    AnyElement, App, Div, ElementId, Entity, Focusable as _, FontWeight, HighlightStyle,
    InteractiveElement as _, IntoElement as _, KeyDownEvent, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, StyledText, Window, div, px,
};
use gpui_elements::editable_text::{EditableTextState, TextChanged, text_input};

use super::{Action, Change, CommandPaletteItem, CommandPalettePanel, Nav, clamp, is_toggle_key};
use crate::tokens::{Color, Length, Number};
use crate::ui::context::{Ds, Platform};
use crate::ui::icon::{IconSize, icon};
use crate::ui::icon_button::IconButton;
use crate::ui::scroll::{Axis, bar};
use crate::ui::{Icon, convert, focus, text};

/// `.inputRow`: `min-height: 54px; gap: 10px; padding: 0 14px` (DS: CommandPanel.module.css:24).
const INPUT_ROW_MIN_HEIGHT: f32 = 54.;
const INPUT_ROW_GAP: f32 = 10.;
const INPUT_ROW_PAD_X: f32 = 14.;
/// `.results`: `max-height: 360px; min-height: 80px; padding: 6px` (DS: CommandPanel.module.css:46).
const RESULTS_MAX_HEIGHT: f32 = 360.;
const RESULTS_MIN_HEIGHT: f32 = 80.;
const RESULTS_PAD: f32 = 6.;
/// Phones: `max-height: calc(var(--adaptive-viewport-block-size) * 0.6)`
/// (DS: CommandPanel.module.css:88).
const RESULTS_COMPACT_SHARE: f32 = 0.6;
/// `[role="option"]`: `min-height: 42px; grid-template-columns: 24px 1fr auto; gap: 10px;
/// padding: 0 10px` (DS: CommandPanel.module.css:53).
const OPTION_MIN_HEIGHT: f32 = 42.;
const OPTION_ICON_WIDTH: f32 = 24.;
const OPTION_GAP: f32 = 10.;
const OPTION_PAD_X: f32 = 10.;
/// `.results mark`: `color-mix(in srgb, var(--accent) 18%, transparent)`
/// (DS: CommandPanel.module.css:73).
const MARK_SHARE: f32 = 0.18;
/// The thin scrollbar thumb is the Dialog's (`--line-strong` at 70%; DS: Dialog.module.css:240).
const THUMB_SHARE: f32 = 0.7;

/// The palette cancels the Dialog's content padding (`.palette { padding: 0 }`): its rows and
/// input row run to the surface edges. A phone sheet keeps its safe-area padding on top and at
/// the sides (Dialog.module.css:254).
pub(super) fn flush(panel: Div, ds: &Ds) -> Div {
    let pad = ds.len(Length::Space4);
    if ds.compact() {
        let safe = ds.len(Length::SafeAreaTop);
        panel.mt(safe - pad.max(safe)).mb(-pad)
    } else {
        panel.m(-pad)
    }
}

/// The palette's key handling on its surface: Cmd+K closes, ArrowDown and ArrowUp move the active
/// row (held inside the results), Enter runs it.
pub(super) fn keys(
    nav: &Nav,
    actions: Vec<Action>,
    close: Action,
    platform: Platform,
) -> impl Fn(&KeyDownEvent, &mut Window, &mut App) + 'static {
    let nav = nav.clone();
    move |event, window, cx| {
        if is_toggle_key(event, platform) {
            close(window, cx);
            cx.stop_propagation();
            return;
        }
        let Some(current) = clamp(*nav.active.read(cx), actions.len()) else {
            return;
        };
        match event.keystroke.key.as_str() {
            "down" => nav.set((current + 1).min(actions.len() - 1), true, cx),
            "up" => nav.set(current.saturating_sub(1), true, cx),
            "enter" => actions[current](window, cx),
            _ => return,
        }
        cx.stop_propagation();
    }
}

/// The search glyph, the bare field and the close button over a hairline.
pub(super) fn input_row(
    panel: &CommandPalettePanel,
    nav: &Nav,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let (change, reset) = (panel.on_query_change.clone(), nav.clone());
    // Typing starts the active row over at the first result.
    let on_change: Change = Rc::new(move |text, window, cx| {
        reset.set(0, true, cx);
        change(text, window, cx);
    });
    let field = bare_input(
        (panel.id.clone(), "input").into(),
        &panel.query,
        &panel.placeholder,
        on_change,
        window,
        cx,
    );
    let close = panel.on_close.clone();
    let close_button = IconButton::new((panel.id.clone(), "close"), panel.close_label.clone())
        .glyph(Icon::X)
        .on_click(move |_, window, cx| close(window, cx));
    let ds = Ds::get(cx);
    div()
        .flex()
        .items_center()
        .min_h(px(INPUT_ROW_MIN_HEIGHT))
        .gap(px(INPUT_ROW_GAP))
        .px(px(INPUT_ROW_PAD_X))
        .border_b(ds.len(Length::BorderHairline))
        .border_color(ds.color(Color::Line))
        .child(icon(Icon::Search, IconSize::Lg, ds))
        .child(field)
        .child(close_button)
        .into_any_element()
}

/// The palette's input: the editor alone (no box, border or ring: `.inputRow input` has
/// `outline: 0`), taking the row's leftover width.
fn bare_input(
    id: ElementId,
    value: &SharedString,
    placeholder: &SharedString,
    on_change: Change,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let state = text::state(id.clone(), window, cx);
    listen(&id, &state, on_change, window, cx);
    if state.read(cx).as_str() != value.as_ref() {
        state.update(cx, |state, cx| state.emplace(value, cx));
    }
    let handle = focus::tab_stop(&state.read(cx).focus_handle(cx), true);
    text::register(cx, handle.clone(), state.clone());
    let ds = Ds::get(cx);
    let primary = ds.color(Color::TextPrimary);
    let mut editor = text_input((id, "edit"))
        .whitespace_nowrap()
        .overflow_x_scroll()
        .state(state.downgrade())
        .placeholder(placeholder.clone())
        .placeholder_color(ds.color(Color::Placeholder))
        .selection_color(convert::with_alpha(ds.color(Color::Accent), 0.28))
        .caret_color(primary)
        .marked_color(primary)
        .caret_w(px(1.))
        .text_color(primary)
        .text_size(ds.len(Length::FontSize3))
        .line_height(ds.len(Length::TypoBodyLineHeight))
        .w_full()
        .h(ds.len(Length::TypoBodyLineHeight));
    if !ds.reduced_motion() {
        editor = editor.caret_blink_interval_500ms();
    }
    div()
        .relative()
        .flex_1()
        .min_w_0()
        .child(div().absolute().size_0().track_focus(&handle))
        .child(editor)
        .into_any_element()
}

/// Reports the user's edits to `on_change`: one subscription lives as long as the field, and the
/// handler is the latest the owner passed.
fn listen(
    id: &ElementId,
    state: &Entity<EditableTextState>,
    on_change: Change,
    window: &mut Window,
    cx: &mut App,
) {
    type Slot = Rc<RefCell<Option<Change>>>;
    let slot = window
        .use_keyed_state((id.clone(), "on-change"), cx, |_, _| Slot::default())
        .read(cx)
        .clone();
    *slot.borrow_mut() = Some(on_change);
    window.use_keyed_state((id.clone(), "on-change-sub"), cx, {
        let (slot, state) = (slot.clone(), state.clone());
        move |window, cx| {
            window.subscribe(&state, cx, move |state, _: &TextChanged, window, cx| {
                let handler = slot.borrow().clone();
                if let Some(handler) = handler {
                    let text = state.read(cx).as_str().to_owned();
                    handler(&text, window, cx);
                }
            })
        }
    });
}

/// The results: the feedback, then the option rows, in a scroller of at most 360px (60% of the
/// viewport on a phone) under the Dialog's thin scrollbar.
pub(super) fn results(
    id: &ElementId,
    feedback: Option<AnyElement>,
    items: Vec<CommandPaletteItem>,
    active: Option<usize>,
    nav: &Nav,
    ds: &Ds,
) -> AnyElement {
    let max = if ds.compact() {
        ds.len(Length::AdaptiveViewportBlockSize) * RESULTS_COMPACT_SHARE
    } else {
        px(RESULTS_MAX_HEIGHT)
    };
    let rows = items
        .into_iter()
        .enumerate()
        .map(|(index, item)| row(id, index, item, active == Some(index), nav, ds));
    let scroller = div()
        .id((id.clone(), "results"))
        .flex()
        .flex_col()
        .min_h(px(RESULTS_MIN_HEIGHT))
        .max_h(max)
        .p(px(RESULTS_PAD))
        .overflow_y_scroll()
        .track_scroll(&nav.scroll)
        .children(feedback)
        .children(rows);
    let thumb = bar::thumb(
        &nav.scroll,
        Axis::Y,
        convert::with_alpha(ds.color(Color::LineStrong), THUMB_SHARE),
    );
    div()
        .relative()
        .min_h_0()
        .max_h(max)
        .child(scroller)
        .children(thumb)
        .into_any_element()
}

/// One option: icon column, title and subtitle. The active row is filled; a pointer move over a
/// row makes it the active one.
fn row(
    id: &ElementId,
    index: usize,
    item: CommandPaletteItem,
    selected: bool,
    nav: &Nav,
    ds: &Ds,
) -> AnyElement {
    let row_id: ElementId = (
        id.clone(),
        SharedString::from(format!("option-{}", item.id)),
    )
        .into();
    let (on_select, hover) = (item.on_select, nav.clone());
    let min = if ds.compact() {
        ds.len(Length::TouchTarget)
    } else {
        px(OPTION_MIN_HEIGHT)
    };
    let line = ds.len(Length::TypoBodyLineHeight);
    let mut el = div()
        .id(row_id)
        .flex()
        .items_center()
        .w_full()
        .min_h(min)
        .gap(px(OPTION_GAP))
        .px(px(OPTION_PAD_X))
        .rounded(ds.len(Length::RadiusPanel))
        .cursor_pointer()
        .text_color(ds.color(Color::TextPrimary))
        .text_size(ds.len(Length::FontSize3))
        .line_height(line)
        .on_mouse_move(move |_, _, cx| hover.set(index, false, cx))
        .on_click(move |_, window, cx| on_select(window, cx))
        .child(
            div()
                .flex()
                .flex_none()
                .items_center()
                .w(px(OPTION_ICON_WIDTH))
                .children(item.icon),
        )
        .child(div().flex_1().min_w_0().child(item.title))
        .children(item.subtitle.map(|subtitle| {
            div()
                .flex_none()
                .text_color(ds.color(Color::TextTertiary))
                .text_size(ds.len(Length::FontSize2))
                .line_height(ds.len(Length::TypoLabelLineHeight))
                .child(subtitle)
        }));
    if selected {
        el = el.bg(ds.color(Color::Selection));
    }
    el.into_any_element()
}

/// The byte ranges of `text` that match `query`, ignoring case and surrounding space.
fn matches(text: &str, query: &str) -> Vec<Range<usize>> {
    let needle = query.trim().to_lowercase();
    let lower = text.to_lowercase();
    // Folding that changes the length leaves no byte positions to map back.
    if needle.is_empty() || lower.len() != text.len() {
        return Vec::new();
    }
    lower
        .match_indices(&needle)
        .map(|(at, found)| at..at + found.len())
        .filter(|range| text.is_char_boundary(range.start) && text.is_char_boundary(range.end))
        .collect()
}

/// `text` with the matches of `query` marked (`<mark>` in an item title): the accent at 18% as a
/// fill, in semibold.
pub fn highlight(text: &str, query: &str, ds: &Ds) -> StyledText {
    let mark = HighlightStyle {
        font_weight: Some(FontWeight(ds.number(Number::FontWeightSemibold))),
        background_color: Some(convert::with_alpha(ds.color(Color::Accent), MARK_SHARE)),
        ..HighlightStyle::default()
    };
    let marks = matches(text, query)
        .into_iter()
        .map(move |range| (range, mark));
    StyledText::new(text.to_owned()).with_highlights(marks)
}
