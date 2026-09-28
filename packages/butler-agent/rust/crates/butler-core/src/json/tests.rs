use serde::{Deserialize, Serialize};
use serde_json::json;

use super::*;

#[derive(Serialize, Deserialize)]
struct Envelope {
    output: JsonDocument,
}

/// Format pin: the JavaScript-compatible JSON encoding under persisted hashes
/// and wire documents: escaped byte counts, string projection and sorted
/// collation ties, lone surrogates through nested wire documents, selective
/// field reads, and the `as` semantics of the saturating number conversions.
// test-category: format-pin
#[test]
fn js_compatible_json_encoding_is_stable() {
    // String byte counts include JSON escapes and UTF-8.
    for (value, expected) in [
        ("", 2),
        ("\"\\\n\r\t\u{8}\u{c}", 16),
        ("\u{0}\u{1f}", 14),
        ("한글😀\u{2028}\u{2029}", 18),
    ] {
        assert_eq!(string_bytes(value).unwrap(), expected);
    }
    let body = "x".repeat(1024 * 1024);
    assert_eq!(string_bytes(&body).unwrap(), body.len() + 2);

    // String projection keeps property order and never mutates its input.
    let source: Value = serde_json::from_str(
        r#"{"10":"data:image/png;base64,x","label":"한글\n😀","2":["keep",{"data:image/png;base64,key":"replace"}],"01":1e-7}"#,
    ).unwrap();
    let original = stringify(&source).unwrap();
    let projected = stringify_with_string_projection(&source, |value| {
        (value == "replace" || value.starts_with("data:image/")).then(|| "projected".into())
    })
    .unwrap();
    assert_eq!(
        projected,
        "{\"2\":[\"keep\",{\"data:image/png;base64,key\":\"projected\"}],\"10\":\"projected\",\"label\":\"한글\\n😀\",\"01\":1e-7}"
    );
    assert_eq!(stringify(&source).unwrap(), original);
    assert_eq!(
        stringify_with_string_projection(&source, |_| None).unwrap(),
        original
    );

    // Sorted output keeps collation ties and distinct Unicode keys.
    let input: Value =
        serde_json::from_str(r#"{"é":"é","é":"é","10":"ten","2":"two","nested":{"z":1,"a":2}}"#)
            .unwrap();
    assert_eq!(
        stringify_sorted(&input, &|_, _| std::cmp::Ordering::Equal).unwrap(),
        r#"{"2":"two","10":"ten","é":"é","é":"é","nested":{"z":1,"a":2}}"#
    );

    // Source-encoded documents (lone surrogates) survive nested wire envelopes.
    let cases: Vec<Value> = serde_json::from_str(include_str!("document/source-bun.json")).unwrap();
    assert_eq!(cases.len(), 6);
    for case in cases {
        let encoded = case["encoded"].as_str().unwrap().to_owned();
        let envelope = Envelope {
            output: JsonDocument::from_encoded(encoded.clone()).unwrap(),
        };
        let wire = serde_json::to_string(&envelope).unwrap();
        assert_eq!(wire, format!("{{\"output\":{encoded}}}"));
        let decoded: Envelope = serde_json::from_str(&wire).unwrap();
        assert_eq!(decoded.output, envelope.output);
    }
    #[derive(Deserialize)]
    struct Control {
        ok: bool,
        exit_code: i32,
    }
    let output =
        JsonDocument::from_encoded(r#"{"ok":true,"stdout":"\ud83d","exit_code":0}"#.into())
            .unwrap();
    let control: Control = output.read().unwrap();
    assert!(control.ok);
    assert_eq!(control.exit_code, 0);
    // A caller cannot silently request a lossy scalar-only DOM.
    assert!(output.read::<Value>().is_err());

    // Values enter with the JavaScript encoding; invalid documents are rejected.
    let source: Value = serde_json::from_str(r#"{"10":1.0,"2":1e-7,"label":"é"}"#).unwrap();
    let encoded = JsonDocument::from_value(&source).unwrap();
    assert_eq!(encoded.as_str(), "{\"2\":1e-7,\"10\":1,\"label\":\"é\"}");
    let decoded: Value = encoded.read().unwrap();
    assert_eq!(decoded["10"].as_f64(), source["10"].as_f64());
    assert_eq!(decoded["2"].as_f64(), source["2"].as_f64());
    assert_eq!(decoded["label"], source["label"]);
    assert_eq!(
        JsonDocument::from_value(&json!(null)).unwrap().as_str(),
        "null"
    );
    for invalid in ["", "{} {}", "{", "\"\\uXXYY\"", "NaN", "undefined"] {
        assert!(
            JsonDocument::from_encoded(invalid.into()).is_err(),
            "{invalid}"
        );
    }

    // Selective field reads return exact values and keep the last duplicate.
    let document = JsonDocument::from_encoded(
        r#"{"ok":true,"\ud800":"ignored","\u006fk":false,"body":{"text":"\udfff"}}"#.into(),
    )
    .unwrap();
    assert_eq!(document.field("ok").unwrap(), Some("false"));
    assert_eq!(
        document.field("body").unwrap(),
        Some(r#"{"text":"\udfff"}"#)
    );
    assert_eq!(document.field("absent").unwrap(), None);
    for source in ["null", "false", "2", r#""\ud800""#, r#"[{"ok":false}]"#] {
        let document = JsonDocument::from_encoded(source.into()).unwrap();
        assert_eq!(document.field("ok").unwrap(), None);
    }

    // Saturating conversions match `as`.
    assert_eq!(saturating_usize(f64::NAN), 0);
    assert_eq!(saturating_usize(-3.7), 0);
    assert_eq!(saturating_usize(3.7), 3);
    assert_eq!(saturating_u64(f64::INFINITY), u64::MAX);
    assert_eq!(saturating_u32(1e12), u32::MAX);
    assert_eq!(saturating_u16(65_535.9), u16::MAX);
    assert_eq!(saturating_i64(-3.7), -3);
    assert_eq!(saturating_i64(f64::NEG_INFINITY), i64::MIN);
    assert_eq!(saturating_i32(1e12), i32::MAX);
}

/// Pure-logic table: UTF-16 prefixes and slices count UTF-16 units, clamp
/// unbounded indices and drop a pending surrogate at a zero-length prefix.
// test-category: pure-logic
#[test]
fn utf16_prefix_and_slice_edges() {
    let original = "a😀z";
    let value = Utf16Prefix::new(original, 4);
    assert_eq!(value.len_utf16(), 4);
    assert_eq!(value.utf8_for_hash(), original);
    let empty = Utf16Prefix::new(original, 2).prefix(0);
    assert!(empty.is_empty());
    assert_eq!(empty.json_literal().unwrap(), "\"\"");

    let source = "one😀two".to_owned();
    let slice = Utf16Slice::new(&source, 5, usize::MAX);
    assert_eq!(slice.utf8_lossy(), "two");
    assert_eq!(
        Utf16Slice::new(&source, usize::MAX, usize::MAX).len_utf16(),
        0
    );
    assert_eq!(Utf16Slice::new(&source, 0, usize::MAX).len_utf16(), 8);
}
