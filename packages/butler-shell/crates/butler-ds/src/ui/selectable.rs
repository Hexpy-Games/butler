//! Selectable text (`data-selectable`): a run of text the pointer can select and `Cmd/Ctrl+C`
//! copies. gpui-ce's `EditableText` selects but is an editor (typing changes the text), and gpui
//! has no selection across elements, so this is the selection of one text block: a press sets the
//! anchor, a drag extends it, and the selected range is painted as a background on the text.
//! Selecting across two paragraphs is not supported.
use std::ops::Range;

use gpui::{
    AnyElement, App, ElementId, HighlightStyle, InteractiveElement as _, IntoElement, KeyDownEvent,
    MouseButton, MouseDownEvent, MouseMoveEvent, ParentElement as _, SharedString, Styled as _,
    StyledText, Window, div,
};

use super::context::Ds;
use crate::tokens::Color;

/// The selection of one block: where the press began and what is selected now.
#[derive(Default)]
struct Selection {
    anchor: Option<usize>,
    range: Option<Range<usize>>,
}

/// `highlights` with `selected` painted as a background: ranges split at the selection's ends.
fn with_selection(
    text: &str,
    highlights: Vec<(Range<usize>, HighlightStyle)>,
    selected: Option<Range<usize>>,
    fill: gpui::Hsla,
) -> Vec<(Range<usize>, HighlightStyle)> {
    let Some(selected) = selected.filter(|range| !range.is_empty()) else {
        return highlights;
    };
    let mut cuts = vec![0, text.len(), selected.start, selected.end];
    for (range, _) in &highlights {
        cuts.extend([range.start, range.end]);
    }
    cuts.retain(|cut| text.is_char_boundary(*cut));
    cuts.sort_unstable();
    cuts.dedup();
    let mut out = Vec::new();
    for pair in cuts.windows(2) {
        let piece = pair[0]..pair[1];
        let base = highlights
            .iter()
            .find(|(range, _)| range.start <= piece.start && piece.end <= range.end)
            .map(|(_, style)| *style);
        let inside = selected.start <= piece.start && piece.end <= selected.end;
        match (base, inside) {
            (None, false) => {}
            (base, inside) => {
                let mut style = base.unwrap_or_default();
                if inside {
                    style.background_color = Some(fill);
                }
                out.push((piece, style));
            }
        }
    }
    out
}

/// `text` with its `highlights`, selectable; `finish` turns the styled text into the element
/// that is drawn (an `InteractiveText` for links). `id` keys the selection state and focus.
pub fn selectable(
    id: impl Into<ElementId>,
    text: &SharedString,
    highlights: Vec<(Range<usize>, HighlightStyle)>,
    finish: impl FnOnce(StyledText) -> AnyElement,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let id = id.into();
    let state = window.use_keyed_state((id.clone(), "selection"), cx, |_, _| Selection::default());
    let focus = window
        .use_keyed_state((id.clone(), "focus"), cx, |_, cx| cx.focus_handle())
        .read(cx)
        .clone();
    let fill = Ds::get(cx).color(Color::SelectionStrong);
    let selected = state.read(cx).range.clone();
    let styled = StyledText::new(text.clone())
        .with_highlights(with_selection(text, highlights, selected, fill));
    let layout = styled.layout().clone();
    let (down_layout, move_layout) = (layout.clone(), layout);
    let (on_down, on_move, on_key) = (state.clone(), state.clone(), state);
    let copy_text = text.clone();
    let handle = focus.clone();
    div()
        .id(id)
        .track_focus(&focus)
        .cursor_text()
        .on_mouse_down(
            MouseButton::Left,
            move |event: &MouseDownEvent, window, cx| {
                window.focus(&handle, cx);
                let index = down_layout
                    .index_for_position(event.position)
                    .unwrap_or_else(|nearest| nearest);
                on_down.update(cx, |selection, cx| {
                    selection.anchor = Some(index);
                    selection.range = None;
                    cx.notify();
                });
            },
        )
        .on_mouse_move(move |event: &MouseMoveEvent, _, cx| {
            if event.pressed_button != Some(MouseButton::Left) {
                return;
            }
            let index = move_layout
                .index_for_position(event.position)
                .unwrap_or_else(|nearest| nearest);
            on_move.update(cx, |selection, cx| {
                if let Some(anchor) = selection.anchor {
                    selection.range = Some(anchor.min(index)..anchor.max(index));
                    cx.notify();
                }
            });
        })
        .on_key_down(move |event: &KeyDownEvent, _, cx| {
            let modifiers = event.keystroke.modifiers;
            if event.keystroke.key != "c" || !(modifiers.platform || modifiers.control) {
                return;
            }
            let range = on_key.read(cx).range.clone();
            let chunk = range
                .filter(|range| !range.is_empty())
                .and_then(|range| copy_text.get(range));
            if let Some(chunk) = chunk {
                cx.write_to_clipboard(gpui::ClipboardItem::new_string(chunk.to_owned()));
            }
        })
        .child(finish(styled))
        .into_any_element()
}
