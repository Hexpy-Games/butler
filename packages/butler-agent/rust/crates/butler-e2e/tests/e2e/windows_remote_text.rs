//! Windows SSH command text, checked on any build host.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]
use base64::{Engine, engine::general_purpose::STANDARD};
use butler_platform::{
    powershell_text::{decoded, encoded_command},
    windows_command_line::quote_argument,
};

const HOSTILE: &str = r#"C:\Users\김 유저\a'b"c%PATH%&"#;

// test-category: pure-logic
#[test]
fn powershell_values_survive_encoding() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let command = encoded_command(&format!("$F={}", decoded(HOSTILE)));
    let encoded = command
        .strip_prefix("powershell -NoProfile -NonInteractive -EncodedCommand ")
        .unwrap();
    assert!(
        encoded
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
    );
    let bytes = STANDARD.decode(encoded)?;
    let utf16 = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .copied()
        .map(u16::from_le_bytes)
        .collect::<Vec<_>>();
    let script = String::from_utf16(&utf16)?;
    let (_, value) = script.split_once("FromBase64String('").unwrap();
    let (value, _) = value.split_once("')").unwrap();
    assert_eq!(String::from_utf8(STANDARD.decode(value)?)?, HOSTILE);
    Ok(())
}

// test-category: pure-logic
#[test]
fn windows_arguments_follow_msvc_quoting() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    for (value, expected) in [
        ("", "\"\""),
        ("a b", r#""a b""#),
        (r#"a"b"#, r#""a\"b""#),
        (r"a\", r#""a\\""#),
        (r#"a\"b"#, r#""a\\\"b""#),
        (r"C:\x\", r#""C:\x\\""#),
        (HOSTILE, r#""C:\Users\김 유저\a'b\"c%PATH%&""#),
    ] {
        assert_eq!(quote_argument(value), expected);
    }
    Ok(())
}
