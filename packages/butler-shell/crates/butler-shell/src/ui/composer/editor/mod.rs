//! `ComposerTextArea`, `ComposerEditorPlugin`, `composition.ts`, `draftSync.ts`, `composerFocus.ts`
//! on gpui-ce EditableText.
//!
//! EditableText holds plain text, so an atom is one reserved private-use character in that text
//! (`U+E000` plus the atom's index in the editor's atom table); the chip is drawn over it
//! (`atoms.rs`). The characters survive typing, selection, undo and redo like any other text.
pub(crate) mod atoms;
pub(crate) mod clipboard;
pub(crate) mod drop;
pub(crate) mod mentions;
pub(crate) mod serialize;

use std::ops::Range;

use gpui::{
    App, Bounds, Entity, EntityInputHandler as _, Focusable as _, Pixels, Point, SharedString,
    Window, utf8_to_utf16_offset, utf16_to_utf8_offset,
};
use gpui_elements::editable_text::EditableTextState;

use self::mentions::mention_token;
use self::serialize::append_part;
use crate::ui::source::wire::ProjectSourceContentPart;

/// An inline atom (Lexical decorator node).
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Atom {
    /// `ProjectReferenceNode`.
    Project { id: String, label: SharedString },
    /// `SessionReferenceNode` (a dropped sidebar session).
    Session { id: String, label: SharedString },
    /// `ProjectSourceNode`: `id` is the source's id, `part` the whole content part.
    ProjectSource {
        id: String,
        label: SharedString,
        part: ProjectSourceContentPart,
    },
}

/// The editor content in order (`serialization.ts`).
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum ComposerPart {
    Text(String),
    Atom(Atom),
}

/// The first and last private-use characters an atom can take.
const ATOM_FIRST: u32 = 0xE000;
const ATOM_LAST: u32 = 0xF8FF;

/// Whether `c` is an atom's reserved character.
pub(crate) fn is_atom_char(c: char) -> bool {
    (ATOM_FIRST..=ATOM_LAST).contains(&(c as u32))
}

/// `ComposerFocusPlacement`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FocusPlacement {
    Restore,
    End,
}

/// The last selection the editor reported (`savedSelection`), as UTF-8 byte offsets.
#[derive(Clone, Debug)]
struct SavedSelection {
    range: Range<usize>,
    reversed: bool,
}

/// The composer's rich-text editor: EditableText plus atom characters.
///
/// `parts` is the latest content: what the field holds, or, while `held` is set, what the field
/// will hold once the IME is idle. Writes from outside the field (`write`, `insert_atom`, `clear`)
/// are held while the IME composes, so they never commit its text early.
#[derive(Default)]
pub(crate) struct ComposerEditor {
    parts: Vec<ComposerPart>,
    input: Option<Entity<EditableTextState>>,
    atoms: Vec<Atom>,
    held: Option<Vec<ComposerPart>>,
    saved: Option<SavedSelection>,
}

impl ComposerEditor {
    /// Attaches the EditableText this editor drives.
    pub(crate) fn bind(&mut self, input: Entity<EditableTextState>) {
        self.input = Some(input);
    }

    pub(crate) fn parts(&self) -> &[ComposerPart] {
        &self.parts
    }

    /// Appends `atom` to the content. Call `settle` to put it into the field.
    pub(crate) fn insert_atom(&mut self, atom: Atom) {
        append_part(&mut self.parts, ComposerPart::Atom(atom));
        self.hold_current();
    }

    /// Empties the content. Call `settle` to empty the field.
    pub(crate) fn clear(&mut self) {
        self.parts.clear();
        self.hold_current();
    }

    fn hold_current(&mut self) {
        if self.input.is_some() {
            self.held = Some(self.parts.clone());
        }
    }

    /// `hasHeldWrites`: a write waits for the IME and is newer than the field.
    pub(crate) fn has_held_writes(&self) -> bool {
        self.held.is_some()
    }

    /// `isComposerComposing`: the IME has marked text in the field.
    pub(crate) fn composing(&self, window: &mut Window, cx: &mut App) -> bool {
        self.input.as_ref().is_some_and(|input| {
            input.update(cx, |input, cx| {
                input.marked_text_range(window, cx).is_some()
            })
        })
    }

    /// The atom a reserved character stands for.
    pub(crate) fn atom_for(&self, c: char) -> Option<&Atom> {
        let index = (c as u32).checked_sub(ATOM_FIRST)?;
        self.atoms.get(usize::try_from(index).ok()?)
    }

    /// The field's text, atoms as their reserved characters.
    pub(crate) fn text(&self, cx: &App) -> String {
        self.input
            .as_ref()
            .map(|input| input.read(cx).as_str().to_owned())
            .unwrap_or_default()
    }

    /// The reserved character for `atom`, added to the table the first time.
    fn atom_char(&mut self, atom: &Atom) -> Option<char> {
        let index = match self.atoms.iter().position(|known| known == atom) {
            Some(index) => index,
            None => {
                self.atoms.push(atom.clone());
                self.atoms.len() - 1
            }
        };
        char::from_u32(ATOM_FIRST.checked_add(u32::try_from(index).ok()?)?)
            .filter(|c| is_atom_char(*c))
    }

    /// Field text for `parts`. Reserved characters in text are dropped.
    fn encode(&mut self, parts: &[ComposerPart]) -> String {
        let mut text = String::new();
        for part in parts {
            match part {
                ComposerPart::Text(run) => text.extend(run.chars().filter(|c| !is_atom_char(*c))),
                ComposerPart::Atom(atom) => text.extend(self.atom_char(atom)),
            }
        }
        text
    }

    /// `$readComposerContent`: the parts of field text. A reserved character with no atom is dropped.
    fn decode(&self, text: &str) -> Vec<ComposerPart> {
        let mut parts = Vec::new();
        let mut run = String::new();
        for c in text.chars() {
            if !is_atom_char(c) {
                run.push(c);
                continue;
            }
            append_part(&mut parts, ComposerPart::Text(std::mem::take(&mut run)));
            if let Some(atom) = self.atom_for(c) {
                append_part(&mut parts, ComposerPart::Atom(atom.clone()));
            }
        }
        append_part(&mut parts, ComposerPart::Text(run));
        parts
    }

    /// `syncEditorFromStore`: puts the store's draft into the field, once the IME is idle.
    pub(crate) fn write(&mut self, parts: Vec<ComposerPart>, window: &mut Window, cx: &mut App) {
        if self.parts == parts {
            return;
        }
        self.parts = parts;
        self.hold_current();
        self.settle(window, cx);
    }

    /// `afterComposition`: runs the held write when the IME is idle.
    pub(crate) fn settle(&mut self, window: &mut Window, cx: &mut App) {
        if self.held.is_none() || self.composing(window, cx) {
            return;
        }
        let Some(held) = self.held.take() else {
            return;
        };
        let Some(input) = self.input.clone() else {
            return;
        };
        self.atoms.clear();
        let text = self.encode(&held);
        self.parts = self.decode(&text);
        input.update(cx, |input, cx| {
            input.emplace(&text, cx);
            input.clear_history();
            input.move_to(text.len(), cx);
        });
    }

    /// `saveDraftFromEditor`'s read: call on every `TextChanged`. Returns whether the content
    /// changed, so the caller saves the draft. While a write is held the store is newer.
    pub(crate) fn on_text_changed(&mut self, window: &mut Window, cx: &mut App) -> bool {
        self.settle(window, cx);
        if self.held.is_some() || self.input.is_none() {
            return false;
        }
        self.save_selection(window, cx);
        let parts = self.decode(&self.text(cx));
        let changed = parts != self.parts;
        self.parts = parts;
        changed
    }

    /// `savedSelection`: remembers the field's selection for `FocusPlacement::Restore`.
    pub(crate) fn save_selection(&mut self, window: &mut Window, cx: &mut App) {
        let Some(input) = self.input.clone() else {
            return;
        };
        let text = self.text(cx);
        let selection = input.update(cx, |input, cx| input.selected_text_range(false, window, cx));
        self.saved = selection.map(|selection| SavedSelection {
            range: utf16_to_utf8_offset(&text, selection.range.start)
                ..utf16_to_utf8_offset(&text, selection.range.end),
            reversed: selection.reversed,
        });
    }

    /// `select` in `composerFocus.ts`: the saved selection while it still lies in the text,
    /// otherwise the end.
    fn select(&self, placement: FocusPlacement, cx: &mut App) {
        let Some(input) = self.input.clone() else {
            return;
        };
        let text = self.text(cx);
        let saved = self.saved.clone().filter(|saved| {
            placement == FocusPlacement::Restore
                && saved.range.end <= text.len()
                && text.is_char_boundary(saved.range.start)
                && text.is_char_boundary(saved.range.end)
        });
        input.update(cx, |input, cx| match saved {
            Some(saved) => {
                let (from, to) = if saved.reversed {
                    (saved.range.end, saved.range.start)
                } else {
                    (saved.range.start, saved.range.end)
                };
                input.move_to(from, cx);
                input.select_to(to, cx);
            }
            None => input.move_to(text.len(), cx),
        });
    }

    /// `focusComposer`: focuses the field and places the selection. The IME owns the selection
    /// while it composes, so nothing moves then.
    pub(crate) fn focus(&mut self, placement: FocusPlacement, window: &mut Window, cx: &mut App) {
        let Some(input) = self.input.clone() else {
            return;
        };
        if self.composing(window, cx) {
            return;
        }
        self.select(placement, cx);
        let handle = input.read(cx).focus_handle(cx);
        window.focus(&handle, cx);
    }

    /// `activate` in `composerFocus.ts`: when the window regains focus with the field focused,
    /// the caret goes to the end.
    pub(crate) fn on_window_activated(&mut self, window: &mut Window, cx: &mut App) {
        let Some(input) = self.input.clone() else {
            return;
        };
        let focused = input.read(cx).focus_handle(cx).is_focused(window);
        if focused && !self.composing(window, cx) {
            self.select(FocusPlacement::End, cx);
        }
    }

    /// Replaces the UTF-8 `range` of the field (the selection when `None`) with `text`.
    fn replace(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        window: &mut Window,
        cx: &mut App,
    ) {
        let Some(input) = self.input.clone() else {
            return;
        };
        let current = self.text(cx);
        let range = range.map(|range| {
            utf8_to_utf16_offset(&current, range.start)..utf8_to_utf16_offset(&current, range.end)
        });
        input.update(cx, |input, cx| {
            input.replace_text_in_range(range, text, window, cx);
        });
    }

    /// `$insertNodes` of one atom at the selection. Returns whether the atom fit the table.
    pub(crate) fn insert_atom_at_caret(
        &mut self,
        atom: &Atom,
        window: &mut Window,
        cx: &mut App,
    ) -> bool {
        let Some(c) = self.atom_char(atom) else {
            return false;
        };
        self.replace(None, &c.to_string(), window, cx);
        true
    }

    /// The `@word` replacement of `replaceMentionToken`: the UTF-8 `range` becomes `atom` and
    /// `trailing` (a space unless whitespace follows).
    pub(crate) fn replace_with_atom(
        &mut self,
        range: Range<usize>,
        atom: &Atom,
        trailing: &str,
        window: &mut Window,
        cx: &mut App,
    ) -> bool {
        let Some(c) = self.atom_char(atom) else {
            return false;
        };
        self.replace(Some(range), &format!("{c}{trailing}"), window, cx);
        true
    }

    /// `appendDraftText`: `text` at the end, then focus.
    pub(crate) fn append_text(&mut self, text: &str, window: &mut Window, cx: &mut App) {
        let clean: String = text.chars().filter(|c| !is_atom_char(*c)).collect();
        let end = self.text(cx).len();
        self.replace(Some(end..end), &clean, window, cx);
        self.focus(FocusPlacement::End, window, cx);
    }

    /// The selection's caret as a UTF-8 offset in the field's text.
    fn caret(&self, window: &mut Window, cx: &mut App) -> Option<usize> {
        let input = self.input.clone()?;
        let text = self.text(cx);
        let selection =
            input.update(cx, |input, cx| input.selected_text_range(false, window, cx))?;
        let end = if selection.reversed {
            selection.range.start
        } else {
            selection.range.end
        };
        Some(utf16_to_utf8_offset(&text, end))
    }

    /// `replaceMentionToken`: the `@word` ending at the caret becomes `atom` and a space (none
    /// added when whitespace follows), as one edit (one undo step) that leaves the caret after
    /// the space. Nothing happens while the IME composes. Returns whether it replaced a token.
    pub(crate) fn apply_mention(&mut self, atom: &Atom, window: &mut Window, cx: &mut App) -> bool {
        if self.composing(window, cx) {
            return false;
        }
        let Some(caret) = self.caret(window, cx) else {
            return false;
        };
        let text = self.text(cx);
        let Some(token) = mention_token(&text, caret) else {
            return false;
        };
        let spaced = text[token.end..]
            .chars()
            .next()
            .is_some_and(char::is_whitespace);
        let trailing = if spaced { "" } else { " " };
        self.replace_with_atom(token.start..token.end, atom, trailing, window, cx)
    }

    /// The `@word` under the caret, for the mention list; `None` while the IME composes
    /// (`mentionKeys` are skipped then).
    pub(crate) fn active_mention(
        &self,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<mentions::MentionToken> {
        if self.composing(window, cx) {
            return None;
        }
        let caret = self.caret(window, cx)?;
        mention_token(&self.text(cx), caret)
    }

    /// The box of the text in the UTF-8 `range` (the caret's box when empty), in window
    /// coordinates. `field` is the editor element's bounds; anchors the mention list above the `@`.
    pub(crate) fn range_bounds(
        &self,
        range: Range<usize>,
        field: Bounds<Pixels>,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<Bounds<Pixels>> {
        let input = self.input.clone()?;
        let text = self.text(cx);
        let range =
            utf8_to_utf16_offset(&text, range.start)..utf8_to_utf16_offset(&text, range.end);
        input.update(cx, |input, cx| {
            input.bounds_for_range(range, field, window, cx)
        })
    }

    /// Puts the caret at the UTF-8 `offset` of the field.
    pub(crate) fn place_caret(&mut self, offset: usize, cx: &mut App) {
        if let Some(input) = self.input.clone() {
            input.update(cx, |input, cx| input.move_to(offset, cx));
        }
    }

    /// The byte offset of the character under `point` (window coordinates).
    pub(crate) fn offset_at(
        &self,
        point: Point<Pixels>,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<usize> {
        let input = self.input.clone()?;
        let text = self.text(cx);
        let index = input.update(cx, |input, cx| {
            input.character_index_for_point(point, window, cx)
        })?;
        Some(utf16_to_utf8_offset(&text, index))
    }
}
