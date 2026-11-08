//! What EditableText does not do once a scroll handle tracks its scroll (the underline
//! textarea's fade needs one): scroll the caret into view after an edit or a caret move. And the
//! harness probes that report a field's text, caret and IME marked range.
use gpui::{
    App, Div, Entity, EntityInputHandler as _, InteractiveElement as _, IntoElement, Pixels,
    ScrollHandle, Styled as _, Window, canvas, div, point,
};
use gpui_elements::editable_text::EditableTextState;

/// The editor version and selection the caret was last revealed for.
#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct Seen(u16, usize, usize);

/// Scrolls `handle` so the caret is inside the field, once per edit or caret move (a wheel scroll
/// is left alone). `reserve` is the room under the last line. Place it over the editor's box.
pub(super) fn follow_caret(
    state: Entity<EditableTextState>,
    handle: ScrollHandle,
    seen: Entity<Seen>,
    reserve: Pixels,
) -> impl IntoElement {
    canvas(
        |bounds, _, _| bounds,
        move |_, bounds, window, cx| {
            let (version, selection) = state.update(cx, |state, cx| {
                (
                    state.version(),
                    state.selected_text_range(false, window, cx),
                )
            });
            let Some(selection) = selection else { return };
            let key = Seen(version, selection.range.start, selection.range.end);
            if *seen.read(cx) == key {
                return;
            }
            seen.update(cx, |seen, _| *seen = key);
            let caret = if selection.reversed {
                selection.range.start
            } else {
                selection.range.end
            };
            let Some(rect) = state.update(cx, |state, cx| {
                state.bounds_for_range(caret..caret, bounds, window, cx)
            }) else {
                return;
            };
            let view = handle.bounds();
            let floor = view.bottom() - reserve;
            let shift = if rect.top() < view.top() {
                view.top() - rect.top()
            } else if rect.bottom() > floor {
                floor - rect.bottom()
            } else {
                return;
            };
            let offset = handle.offset();
            handle.set_offset(point(offset.x, offset.y + shift));
            crate::ui::motion::remeasure(window);
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
}

/// Zero-size markers for `expect anchor`: `<name>:<text>`, `<name>:caret:<utf16 index>` and
/// `<name>:marked:<start>-<end>|none`. Only the test build draws them.
pub(super) fn probe(
    name: &str,
    state: &Entity<EditableTextState>,
    window: &mut Window,
    cx: &mut App,
) -> Vec<Div> {
    let (text, selection, marked) = state.update(cx, |state, cx| {
        (
            state.as_str().to_owned(),
            state.selected_text_range(false, window, cx),
            state.marked_text_range(window, cx),
        )
    });
    let caret = selection.map_or(0, |s| {
        if s.reversed {
            s.range.start
        } else {
            s.range.end
        }
    });
    let marked = marked.map_or_else(|| "none".to_owned(), |r| format!("{}-{}", r.start, r.end));
    [
        format!("{name}:{text}"),
        format!("{name}:caret:{caret}"),
        format!("{name}:marked:{marked}"),
    ]
    .into_iter()
    .map(|label| div().absolute().size_0().debug_selector(move || label))
    .collect()
}
