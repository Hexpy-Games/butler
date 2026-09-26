use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::*;

#[derive(Serialize, Deserialize)]
struct Envelope {
    output: JsonDocument,
}

#[test]
fn source_json_surrogates_survive_nested_wire_and_selective_controls() {
    let cases: Vec<Value> = serde_json::from_str(include_str!("source-bun.json")).unwrap();
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
}

#[test]
fn value_entry_uses_js_encoding_and_rejects_invalid_encoded_documents() {
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
}

#[test]
fn selective_fields_read_exact_values_and_keep_last_duplicate() {
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
}
