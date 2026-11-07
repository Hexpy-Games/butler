//! `drop-selection.ts`: a drop lands at the character under the pointer, never at the end of
//! the draft. `browserComposition.ts` has no counterpart: it keeps the browser's contenteditable
//! alive during IME composition, and the gpui-ce EditableText composes through the platform
//! input handler itself.
use gpui::SharedString;

/// The payload of a sidebar session row being dragged (`useSpaceDrag`, source `s:<id>`): the
/// composer takes it as a session reference. The sidebar starts the drag with
/// `on_drag(SessionDrag { .. }, ghost)`.
#[derive(Clone, Debug)]
pub(crate) struct SessionDrag {
    pub(crate) id: String,
    pub(crate) title: SharedString,
}
