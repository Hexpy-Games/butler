use super::*;
use serde_json::json;

#[test]
fn public_projection_redacts_secrets_and_replaces_private_text_with_fallback() {
    // (input, fallback, projected): secrets are redacted in place; reasoning tags
    // (also base64-encoded), internal identifiers and local paths fall back.
    for (value, fallback, expected) in [
        (" hello ", "Working", "hello"),
        ("\u{feff}hello\u{feff}", "Working", "hello"),
        ("", "Working", "Working"),
        ("  ", "", ""),
        ("API_KEY=abc", "", "[redacted]"),
        ("token = abc", "", "[redacted]"),
        ("token=abc secret=def", "", "[redacted] [redacted]"),
        ("atoken=abc secret=def", "", "atoken=abc [redacted]"),
        ("auth: bearer abc", "", "[redacted]"),
        ("Bearer [redacted]", "", "Bearer [redacted]"),
        ("<think>abc</think>", "Working", "Working"),
        ("PHRoaW5rPmFiYzwvdGhpbms+", "Working", "Working"),
        ("<|analysis|>private", "", ""),
        ("sessionId", "", ""),
        ("ENOENT", "", ""),
        ("/Users/test", "Working", "Working"),
        ("C:\\hello", "Working", "Working"),
        ("\\\\server\\share", "", ""),
    ] {
        assert_eq!(sanitize_public_text(value, fallback), expected, "{value:?}");
    }
    assert_eq!(sanitize_public_value(&json!(null), "Working"), "Working");
    assert_eq!(sanitize_public_value(&json!(true), ""), "true");
    assert_eq!(sanitize_public_value(&json!(12), "Working"), "12");
}
