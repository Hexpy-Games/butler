//! The address field's edit mode: the DS text editor (EditableText, as Input drives it) bare in
//! the pill. It takes focus with the full URL selected; Enter submits, Escape and blur cancel.
//! The DS Input draws its own box and has no autofocus, key or blur hook, so the field drives
//! the editor itself (the Input's state, tab stop and harness registration are the same).
use std::cell::RefCell;
use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, Entity, FocusHandle, Focusable as _, InteractiveElement as _,
    IntoElement as _, KeyDownEvent, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, div, px,
};
use gpui_elements::editable_text::actions::Enter;
use gpui_elements::editable_text::{EditableTextState, TextChanged, text_input};

use crate::tokens::{Color, Length};
use crate::ui::context::Ds;
use crate::ui::{convert, focus, text};

pub(super) type Submit = Rc<dyn Fn(String, &mut Window, &mut App)>;
pub(super) type SetEditing = Rc<dyn Fn(bool, &mut Window, &mut App)>;
pub(super) type Input = Rc<dyn Fn(String, &mut Window, &mut App)>;
/// Runs before the built-in keys: `true` means it took the key (a highlighted suggestion takes
/// Enter, an open list the first Escape).
pub(super) type KeyHook = Rc<dyn Fn(&KeyDownEvent, &mut Window, &mut App) -> bool>;

pub(super) struct Edit {
    pub id: ElementId,
    pub url: SharedString,
    pub placeholder: SharedString,
    pub submit: Option<Submit>,
    pub set_editing: SetEditing,
    pub on_input: Option<Input>,
    pub on_key: Option<KeyHook>,
}

fn key(id: &ElementId) -> ElementId {
    (id.clone(), "address-edit").into()
}

/// The editor's focus handle, for a suggestions popover that has to know where focus is.
pub fn focus_handle(id: &ElementId, window: &mut Window, cx: &mut App) -> FocusHandle {
    text::state(key(id), window, cx).read(cx).focus_handle(cx)
}

/// What the editor has done since it opened: it took focus, selected the URL, and had focus.
#[derive(Default, Clone, Copy)]
struct Phase {
    loaded: bool,
    selected: bool,
    had_focus: bool,
}

/// Leaving edit mode: the next one starts again from the URL.
pub(super) fn reset(id: &ElementId, window: &mut Window, cx: &mut App) {
    let phase = window.use_keyed_state((id.clone(), "address-phase"), cx, |_, _| Phase::default());
    if phase.read(cx).loaded {
        phase.update(cx, |phase, _| *phase = Phase::default());
    }
}

/// `onChange` of the typed text: one subscription for the field's life, the latest handler
/// read when an edit arrives.
fn listen(edit: &Edit, state: &Entity<EditableTextState>, window: &mut Window, cx: &mut App) {
    type Slot = Rc<RefCell<Option<Input>>>;
    let slot = window
        .use_keyed_state((edit.id.clone(), "address-input"), cx, |_, _| {
            Slot::default()
        })
        .read(cx)
        .clone();
    slot.borrow_mut().clone_from(&edit.on_input);
    window.use_keyed_state((edit.id.clone(), "address-input-sub"), cx, {
        let state = state.clone();
        move |window, cx| {
            window.subscribe(&state, cx, move |state, _: &TextChanged, window, cx| {
                let handler = slot.borrow().clone();
                if let Some(handler) = handler {
                    handler(state.read(cx).as_str().to_owned(), window, cx);
                }
            })
        }
    });
}

/// Moves the editor along its phases: the URL in, focus in, the URL selected; and out again on
/// blur. Each step that waits for a frame asks for one.
fn advance(
    edit: &Edit,
    state: &Entity<EditableTextState>,
    handle: &FocusHandle,
    window: &mut Window,
    cx: &mut App,
) {
    let phase = window.use_keyed_state((edit.id.clone(), "address-phase"), cx, |_, _| {
        Phase::default()
    });
    let now = *phase.read(cx);
    if !now.loaded {
        // Loading the URL is a silent replacement, not an edit the owner hears about.
        state.update(cx, |state, cx| state.emplace(&edit.url, cx));
        phase.update(cx, |phase, _| phase.loaded = true);
    }
    let focused = handle.is_focused(window);
    if focused && !now.selected {
        text::select_focused(window, cx);
        phase.update(cx, |phase, _| {
            phase.selected = true;
            phase.had_focus = true;
        });
    } else if !focused && !now.had_focus {
        // Focus moving redraws the field; the next frame selects the URL.
        handle.focus(window, cx);
    } else if !focused && now.selected {
        (edit.set_editing)(false, window, cx);
    }
}

/// Enter: submits the trimmed text and leaves edit mode.
fn submit(edit: &Edit, state: &Entity<EditableTextState>, window: &mut Window, cx: &mut App) {
    let value = state.read(cx).as_str().trim().to_owned();
    if let Some(submit) = &edit.submit {
        submit(value, window, cx);
    }
    (edit.set_editing)(false, window, cx);
    cx.stop_propagation();
}

/// The built-in keys: Escape cancels (Enter is an action of the editor, see `editor`).
fn on_key(edit: &Edit, event: &KeyDownEvent, window: &mut Window, cx: &mut App) {
    if edit
        .on_key
        .as_ref()
        .is_some_and(|hook| hook(event, window, cx))
    {
        return;
    }
    if event.keystroke.key == "escape" {
        (edit.set_editing)(false, window, cx);
        cx.stop_propagation();
    }
}

pub(super) fn editor(edit: Edit, window: &mut Window, cx: &mut App) -> AnyElement {
    let state = text::state(key(&edit.id), window, cx);
    let handle = focus::tab_stop(&state.read(cx).focus_handle(cx), true);
    text::register(cx, handle.clone(), state.clone());
    listen(&edit, &state, window, cx);
    advance(&edit, &state, &handle, window, cx);
    let ds = Ds::get(cx);
    let color = ds.color(Color::TextPrimary);
    let mut input = text_input((edit.id.clone(), "address-text"))
        .whitespace_nowrap()
        .overflow_x_scroll()
        .state(state.downgrade())
        .placeholder(edit.placeholder.clone())
        .placeholder_color(ds.color(Color::Placeholder))
        .selection_color(convert::with_alpha(ds.color(Color::Accent), 0.28))
        .caret_color(color)
        .marked_color(color)
        .caret_w(px(1.))
        .text_color(color)
        .text_size(ds.len(Length::FontSize2))
        .line_height(ds.len(Length::TypoLabelLineHeightTight))
        .w_full();
    if !ds.reduced_motion() {
        input = input.caret_blink_interval_500ms();
    }
    let hook = Rc::new(edit);
    let enter = (state.clone(), hook.clone());
    div()
        .flex()
        .flex_auto()
        .min_w_0()
        .h_full()
        .items_center()
        .child(div().absolute().size_0().track_focus(&handle))
        // The editor takes Enter as an action and keeps it, so the field listens first.
        .capture_action(move |_: &Enter, window, cx| submit(&enter.1, &enter.0, window, cx))
        // Capture phase: the editor handles Enter itself, so the field takes it first.
        .capture_key_down(move |event, window, cx| on_key(&hook, event, window, cx))
        .child(input)
        .into_any_element()
}
