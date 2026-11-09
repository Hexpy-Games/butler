//! Renames the item in place (LibraryTitleInput.tsx): the title row becomes a field with its text
//! selected. It commits once (Enter, Tab or leaving the field), Escape cancels.
use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, Entity, EntityInputHandler as _, Focusable as _, FontWeight,
    InteractiveElement as _, IntoElement as _, KeyDownEvent, ParentElement as _, SharedString,
    Styled as _, Window, div,
};
use gpui_elements::editable_text::actions::Enter;
use gpui_elements::editable_text::{EditableTextState, StringStorage};

use crate::tokens::{Color, Length, Number};
use crate::ui::context::Ds;
use crate::ui::text::Input;

/// The name field takes at most this many characters.
const MAX_LENGTH: usize = 200; // DS: LibraryTitleInput.tsx:30

type Commit = Rc<dyn Fn(&str, &mut Window, &mut App)>;
type Cancel = Rc<dyn Fn(&mut Window, &mut App)>;
type Finish = Rc<dyn Fn(bool, &mut Window, &mut App)>;

/// Renames the item in place: the title becomes a name field.
pub struct LibraryCardEditing {
    pub value: SharedString,
    /// Accessible name of the field ("Name").
    pub label: SharedString,
    on_commit: Commit,
    on_cancel: Cancel,
}

impl LibraryCardEditing {
    pub fn new(
        value: impl Into<SharedString>,
        label: impl Into<SharedString>,
        on_commit: impl Fn(&str, &mut Window, &mut App) + 'static,
        on_cancel: impl Fn(&mut Window, &mut App) + 'static,
    ) -> Self {
        Self {
            value: value.into(),
            label: label.into(),
            on_commit: Rc::new(on_commit),
            on_cancel: Rc::new(on_cancel),
        }
    }
}

/// Where the edit stands: focus given, focus seen in a frame, and the one commit or cancel done.
#[derive(Default)]
struct Edit {
    entered: bool,
    seen: bool,
    done: bool,
}

/// Commits (`true`) or cancels once, whichever comes first.
fn finisher(
    edit: Entity<Edit>,
    text: Entity<EditableTextState>,
    editing: &LibraryCardEditing,
) -> Finish {
    let (commit, cancel) = (editing.on_commit.clone(), editing.on_cancel.clone());
    Rc::new(move |save: bool, window: &mut Window, cx: &mut App| {
        if edit.update(cx, |edit, _| std::mem::replace(&mut edit.done, true)) {
            return;
        }
        if !save {
            return cancel(window, cx);
        }
        let value: String = text.read(cx).as_str().chars().take(MAX_LENGTH).collect();
        commit(value.trim(), window, cx);
    })
}

/// The IME has marked text in the field: Enter and Escape belong to the composition.
fn composing(text: &Entity<EditableTextState>, window: &mut Window, cx: &mut App) -> bool {
    text.update(cx, |input, cx| {
        input.marked_text_range(window, cx).is_some()
    })
}

pub(super) fn build(
    id: &ElementId,
    editing: &LibraryCardEditing,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let input_id: ElementId = (id.clone(), "title").into();
    let initial = editing.value.clone();
    let text =
        EditableTextState::use_keyed_init((input_id.clone(), "text"), window, cx, move |_, _| {
            StringStorage::from(initial.to_string())
        });
    let handle = text.read(cx).focus_handle(cx);
    let edit = window.use_keyed_state((id.clone(), "edit"), cx, |_, _| Edit::default());
    if !edit.read(cx).entered {
        edit.update(cx, |edit, _| edit.entered = true);
        handle.focus(window, cx);
        text.update(cx, EditableTextState::select_document);
    }
    let focused = handle.is_focused(window);
    let left = edit.update(cx, |edit, _| {
        edit.seen |= focused;
        edit.seen && !focused && !edit.done
    });
    let finish = finisher(edit, text.clone(), editing);
    if left {
        let finish = finish.clone();
        window.defer(cx, move |window, cx| finish(true, window, cx));
    }
    let ds = Ds::get(cx);
    let (enter, escape) = (finish.clone(), finish);
    let (for_enter, for_escape) = (text.clone(), text);
    div()
        .min_w_0()
        .ml(-ds.len(Length::SpaceXs))
        .mr(ds.len(Length::ControlHeightMd))
        .text_color(ds.color(Color::TextPrimary))
        .text_size(ds.len(Length::FontSize2))
        .line_height(ds.len(Length::TypoLabelLineHeight))
        .font_weight(FontWeight(ds.number(Number::FontWeightMedium)))
        .child(Input::new(input_id))
        .capture_action(move |_: &Enter, window, cx| {
            if !composing(&for_enter, window, cx) {
                cx.stop_propagation();
                enter(true, window, cx);
            }
        })
        .capture_key_down(move |event: &KeyDownEvent, window, cx| {
            if event.keystroke.key == "escape" && !composing(&for_escape, window, cx) {
                cx.stop_propagation();
                escape(false, window, cx);
            }
        })
        .into_any_element()
}
