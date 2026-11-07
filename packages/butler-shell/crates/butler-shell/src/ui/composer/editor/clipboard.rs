//! `clipboard.ts`: copy/cut/paste with atoms. A copy carries the selection's content parts as the
//! clipboard string's metadata (`BUTLER_CONTENT_MIME`) next to its plain text.
use std::ops::Range;

use gpui::{
    App, ClipboardEntry, ClipboardItem, EntityInputHandler as _, Window, utf16_to_utf8_offset,
};

use super::serialize::{content_json, content_text, parse_content};
use super::{ComposerEditor, ComposerPart, is_atom_char};

/// What a paste did.
pub(crate) enum Paste {
    /// Text or content parts went into the field.
    Inserted,
    /// The clipboard holds files or images: they share the picker/drop gate (model image
    /// capability), so the caller attaches them and nothing is inserted.
    Files(Vec<ClipboardEntry>),
    /// The clipboard holds nothing to insert.
    Nothing,
}

impl ComposerEditor {
    /// The `COPY_COMMAND` / `CUT_COMMAND` handler: writes the selection's text and content parts
    /// to the clipboard, and removes the selection when cutting. Without a selection nothing is
    /// copied or cut. Returns whether it ran; the caller then stops EditableText's own copy.
    pub(crate) fn copy(&mut self, cut: bool, window: &mut Window, cx: &mut App) -> bool {
        let Some(input) = self.input.clone() else {
            return false;
        };
        let text = self.text(cx);
        let Some(selection) =
            input.update(cx, |input, cx| input.selected_text_range(false, window, cx))
        else {
            return true;
        };
        let range: Range<usize> = utf16_to_utf8_offset(&text, selection.range.start)
            ..utf16_to_utf8_offset(&text, selection.range.end);
        if range.is_empty() {
            return true;
        }
        let parts = self.decode(&text[range]);
        cx.write_to_clipboard(ClipboardItem::new_string_with_metadata(
            content_text(&parts),
            content_json(&parts).to_string(),
        ));
        if cut {
            input.update(cx, |input, cx| {
                input.replace_text_in_range(Some(selection.range), "", window, cx);
            });
        }
        true
    }

    /// The `PASTE_COMMAND` handler. Files go to the caller; Butler content whose parts are all
    /// `known` pastes with its atoms; anything else pastes as plain text.
    pub(crate) fn paste(
        &mut self,
        known: &dyn Fn(&ComposerPart) -> bool,
        window: &mut Window,
        cx: &mut App,
    ) -> Paste {
        let Some(item) = cx.read_from_clipboard() else {
            return Paste::Nothing;
        };
        let files: Vec<ClipboardEntry> = item
            .entries()
            .iter()
            .filter(|entry| !matches!(entry, ClipboardEntry::String(_)))
            .cloned()
            .collect();
        if !files.is_empty() {
            return Paste::Files(files);
        }
        let content = item
            .metadata()
            .and_then(|raw| parse_content(raw))
            .filter(|parts| parts.iter().all(known));
        let text = match content {
            Some(parts) => self.encode(&parts),
            None => match item.text() {
                Some(text) => text.chars().filter(|c| !is_atom_char(*c)).collect(),
                None => return Paste::Nothing,
            },
        };
        self.replace(None, &text, window, cx);
        Paste::Inserted
    }
}
