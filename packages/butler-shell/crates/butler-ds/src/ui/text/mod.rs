//! DS Input and Textarea (shadcn/ui/input.tsx, textarea.tsx, Input.module.css,
//! UnderlineField.module.css, Textarea.module.css) on gpui-ce's EditableText, the editor the
//! shell's own field uses: selection, clipboard, undo and IME (marked text and commit) come from
//! it, the DS draws the field around it. A text field shows its focus ring on any focus, mouse
//! included (card section 0.2).
mod field;
mod input;
mod layout;
mod reveal;
mod textarea;

use std::cell::RefCell;

use gpui::{Action as _, App, Entity, FocusHandle, KeyBinding, Unbind, Window};
use gpui_elements::editable_text::EditableTextState;
use gpui_elements::editable_text::actions::{self, DEFAULT_INPUT_CONTEXT};

pub use input::{Input, Variant as InputVariant};
pub use textarea::{Textarea, Variant as TextareaVariant};

/// `textSize`: the underline field's text metrics.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TextSize {
    /// The surrounding text.
    #[default]
    Inherit,
    /// `--typo-label-*`.
    Label,
}

/// EditableText's keys for the DS fields. Enter is the textarea's newline (a single-line field
/// ignores it), Tab and Escape are not editing keys (Tab moves focus), and Home/End move within
/// the line on every platform. Bind them once at start.
pub fn bind_keys(cx: &mut App) {
    let c = Some(DEFAULT_INPUT_CONTEXT);
    let mut keys: Vec<KeyBinding> = actions::default_bindings().as_keybindings(c).collect();
    keys.extend([
        KeyBinding::new("tab", Unbind(actions::Tab.name().into()), c),
        KeyBinding::new("escape", Unbind(actions::Escape.name().into()), c),
        KeyBinding::new("home", actions::NavLineStart, c),
        KeyBinding::new("end", actions::NavLineEnd, c),
    ]);
    cx.bind_keys(keys);
}

/// The editor state of the field `id` (the id given to [`Input::new`] or [`Textarea::new`]):
/// its text, selection and IME marked range. The state exists once the field has rendered.
pub fn state(
    id: impl Into<gpui::ElementId>,
    window: &mut Window,
    cx: &mut App,
) -> Entity<EditableTextState> {
    field::state_of(&id.into(), window, cx, "")
}

/// The fields drawn this frame, so a harness can reach the focused one.
#[derive(Default)]
struct Registry(RefCell<Vec<(FocusHandle, Entity<EditableTextState>)>>);

impl gpui::Global for Registry {}

/// Starts a frame: no field has drawn yet.
pub(crate) fn reset(cx: &mut App) {
    cx.default_global::<Registry>().0.borrow_mut().clear();
}

pub(crate) fn register(cx: &mut App, handle: FocusHandle, state: Entity<EditableTextState>) {
    cx.default_global::<Registry>()
        .0
        .borrow_mut()
        .push((handle, state));
}

/// Focus has just moved onto a text field by Tab or by script: a browser selects an input's text
/// then (a mouse press does not). Call it after moving focus; it does nothing off a field.
pub fn select_focused(window: &mut Window, cx: &mut App) {
    if focused(window, cx).is_some() {
        window.dispatch_action(actions::SelectAll.boxed_clone(), cx);
    }
}

/// The editor of the focused field of the last frame.
pub fn focused(window: &Window, cx: &App) -> Option<Entity<EditableTextState>> {
    let registry = cx.try_global::<Registry>()?;
    let fields = registry.0.borrow();
    fields
        .iter()
        .find(|(handle, _)| handle.is_focused(window))
        .map(|(_, state)| state.clone())
}
