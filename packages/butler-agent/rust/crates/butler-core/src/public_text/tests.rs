use super::*;
use serde_json::json;

/// Security boundary: public text and deltas redact secrets in place and
/// replace reasoning, internal identifiers and local paths with the fallback;
/// deltas keep their whitespace exactly because fragments concatenate.
// test-category: security
#[test]
fn public_text_redacts_secrets_and_private_text() {
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

    // (delta, projected): fragments concatenate, so whitespace is kept exactly;
    // other control characters go and secrets are still redacted.
    for (value, expected) in [
        (" two", " two"),
        ("one ", "one "),
        ("\n\n", "\n\n"),
        ("- a\n- b\n", "- a\n- b\n"),
        ("\tcode", "\tcode"),
        ("line\r\nnext", "line\nnext"),
        ("bell\u{7}", "bell"),
        (" token=abc", " [redacted]"),
        ("auth: bearer abc ", "[redacted] "),
        ("", ""),
    ] {
        assert_eq!(sanitize_public_delta(value), expected, "{value:?}");
    }
}
