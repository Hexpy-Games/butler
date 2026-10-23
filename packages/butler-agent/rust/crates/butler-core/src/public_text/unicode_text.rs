//! Strict BOM-aware Unicode text detection shared by upload and prompt owners.
use std::borrow::Cow;

fn allowed(character: char) -> bool {
    !matches!(character, '\u{0000}'..='\u{0008}' | '\u{000e}'..='\u{0019}' | '\u{001c}'..='\u{001f}')
}
fn utf16(bytes: &[u8]) -> Option<(&[u8], bool)> {
    bytes
        .strip_prefix(&[0xff, 0xfe])
        .map(|rest| (rest, true))
        .or_else(|| bytes.strip_prefix(&[0xfe, 0xff]).map(|rest| (rest, false)))
}
fn units(bytes: &[u8], little: bool) -> impl Iterator<Item = u16> + '_ {
    bytes.as_chunks::<2>().0.iter().map(move |pair| {
        if little {
            u16::from_le_bytes(*pair)
        } else {
            u16::from_be_bytes(*pair)
        }
    })
}
fn utf8(bytes: &[u8]) -> Option<&str> {
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    std::str::from_utf8(bytes)
        .ok()
        .filter(|text| text.chars().all(allowed))
}
/// Recognize strict UTF-8 or BOM-marked UTF-16 without allocating.
pub fn is_unicode_text(bytes: &[u8]) -> bool {
    if let Some((bytes, little)) = utf16(bytes) {
        return bytes.len().is_multiple_of(2)
            && char::decode_utf16(units(bytes, little)).all(|c| c.is_ok_and(allowed));
    }
    utf8(bytes).is_some()
}
/// Decode strict Unicode text, borrowing UTF-8 and owning decoded UTF-16.
pub fn decode_unicode_text(bytes: &[u8]) -> Option<Cow<'_, str>> {
    if let Some((bytes, little)) = utf16(bytes) {
        if !bytes.len().is_multiple_of(2) {
            return None;
        }
        let mut text = String::with_capacity(bytes.len());
        for character in char::decode_utf16(units(bytes, little)) {
            let character = character.ok()?;
            if !allowed(character) {
                return None;
            }
            text.push(character);
        }
        return Some(Cow::Owned(text));
    }
    utf8(bytes).map(Cow::Borrowed)
}
