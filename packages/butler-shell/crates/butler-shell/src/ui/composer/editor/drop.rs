//! `drop-selection.ts`: a drop lands at the character under the pointer, never at the end of
//! the draft. `browserComposition.ts` has no counterpart: it keeps the browser's contenteditable
//! alive during IME composition, and the gpui-ce EditableText composes through the platform
//! input handler itself.

/// The byte offset in `text` nearest to `x` (`caretRangeFromPoint`), given each character's
/// laid-out left edge from the editor's text layout. `None` when the pointer is outside the
/// editor (`!root.contains(range.startContainer)`), so the caller keeps the current selection.
pub(crate) fn drop_offset(text: &str, char_lefts: &[f32], x: f32, inside: bool) -> Option<usize> {
    if !inside || char_lefts.is_empty() {
        return None;
    }
    let chars: Vec<usize> = text.char_indices().map(|(at, _)| at).collect();
    let nearest = char_lefts
        .iter()
        .enumerate()
        .min_by(|a, b| (a.1 - x).abs().total_cmp(&(b.1 - x).abs()))
        .map(|(index, _)| index)?;
    Some(chars.get(nearest).copied().unwrap_or(text.len()))
}
