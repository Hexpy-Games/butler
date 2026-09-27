use super::*;

#[test]
fn complete_prefix_is_unchanged_and_zero_prefix_removes_pending_surrogate() {
    let original = "a😀z";
    let value = Utf16Prefix::new(original, 4);
    assert_eq!(value.len_utf16(), 4);
    assert_eq!(value.utf8_for_hash(), original);
    let empty = Utf16Prefix::new(original, 2).prefix(0);
    assert!(empty.is_empty());
    assert_eq!(empty.json_literal().unwrap(), "\"\"");
}
