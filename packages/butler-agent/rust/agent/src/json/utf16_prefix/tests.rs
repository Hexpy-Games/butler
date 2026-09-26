use super::*;
use sha2::{Digest, Sha256};

#[test]
fn import_prefix_hash_and_prompt_match_bun_surrogate_boundaries() {
    let rows: serde_json::Value = serde_json::from_str(include_str!("bun-golden.json")).unwrap();
    for row in rows.as_array().unwrap() {
        let text =
            "x".repeat(row["pad"].as_u64().unwrap() as usize) + row["suffix"].as_str().unwrap();
        let prefix = Utf16Prefix::new(text, row["limit"].as_u64().unwrap() as usize);
        assert_eq!(prefix.len_utf16(), row["units"].as_u64().unwrap() as usize);
        assert_eq!(
            format!("{:x}", Sha256::digest(prefix.utf8_for_hash().as_bytes())),
            row["hash"].as_str().unwrap()
        );
        let literal = prefix
            .collapse_whitespace(crate::public_text::is_js_whitespace)
            .prefix(row["promptLimit"].as_u64().unwrap() as usize)
            .json_literal()
            .unwrap();
        assert_eq!(
            format!("{:x}", Sha256::digest(literal.as_bytes())),
            row["promptHash"].as_str().unwrap()
        );
        if let Some(expected) = row["literal"].as_str() {
            assert_eq!(literal, expected);
        }
    }
}

#[test]
fn complete_prefix_borrows_and_zero_prefix_removes_pending_surrogate() {
    let original = "a😀z";
    let value = Utf16Prefix::new(original, 4);
    assert!(matches!(value.text, Cow::Borrowed(_)));
    assert_eq!(value.text.as_ptr(), original.as_ptr());
    assert!(matches!(value.utf8_for_hash(), Cow::Borrowed(_)));
    let empty = Utf16Prefix::new(original, 2).prefix(0);
    assert!(empty.is_empty());
    assert_eq!(empty.json_literal().unwrap(), "\"\"");
}
