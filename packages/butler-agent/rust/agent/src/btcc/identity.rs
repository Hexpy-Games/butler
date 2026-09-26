use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::btcc::{BtccError, ContentRef};

pub(super) fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

pub(super) fn content_ref(kind: &str, body: &Value) -> Result<ContentRef, BtccError> {
    let sha256 = digest(&stable_json(body)?);
    Ok(ContentRef {
        id: digest(&format!("btcc-{kind}.v1\0{sha256}")),
        sha256,
    })
}

pub(super) fn stable_json(value: &Value) -> Result<String, BtccError> {
    crate::json::canonical_json(value, crate::json::CanonicalKeyOrder::Utf16Lexical)
        .map_err(identity_error)
}

pub(super) fn sqlite_stable_json(value: &Value) -> Result<String, BtccError> {
    crate::json::canonical_json(value, crate::json::CanonicalKeyOrder::JsPropertyEnumeration)
        .map_err(identity_error)
}

pub(super) fn json_stringify_without(value: &Value, field: &str) -> Result<String, BtccError> {
    crate::json::stringify_without(value, field).map_err(identity_error)
}

fn identity_error(error: crate::json::JsonError) -> BtccError {
    BtccError::new("canonical_json", error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_json_sorts_keys_and_normalizes_unicode() {
        let left = serde_json::json!({"z": 1, "label": "e\u{301}"});
        let right = serde_json::json!({"label": "é", "z": 1});
        assert_eq!(stable_json(&left).unwrap(), stable_json(&right).unwrap());
        assert_eq!(
            content_ref("payload", &left).unwrap(),
            content_ref("payload", &right).unwrap()
        );
    }

    #[test]
    fn matches_legacy_ecmascript_float_bytes_and_hash() {
        let body: Value = serde_json::from_str(
            r#"{"integerFloat":1.0,"negativeZero":-0.0,"small":1e-7,"threshold":0.000001,"large":1e21,"fixed":100000000000000000000}"#,
        ).unwrap();
        let canonical = r#"{"fixed":100000000000000000000,"integerFloat":1,"large":1e+21,"negativeZero":0,"small":1e-7,"threshold":0.000001}"#;
        assert_eq!(stable_json(&body).unwrap(), canonical);
        assert_eq!(
            content_ref("payload", &body).unwrap().sha256,
            "9e6173e18d3c95286f2a9a7221a1e6e87797e8e5fe3377a6ce884c9c5e20a433"
        );
    }

    #[test]
    fn matches_legacy_utf16_key_order_hash() {
        let body = serde_json::json!({"\u{e000}": "bmp", "\u{10000}": "astral", "z": true});
        assert_eq!(
            stable_json(&body).unwrap(),
            "{\"z\":true,\"𐀀\":\"astral\",\"\":\"bmp\"}"
        );
        assert_eq!(
            content_ref("payload", &body).unwrap().sha256,
            "4642d265ee2b6b1aa5607ade607a96801ccb3462db93b06db3e185e754040914"
        );
    }

    #[test]
    fn matches_legacy_nfc_hash() {
        let body = serde_json::json!({"e\u{301}": "A\u{30a}", "label": "e\u{301}", "nested": ["\r\n", "\u{2028}", "\u{2029}"]});
        assert_eq!(
            content_ref("payload", &body).unwrap().sha256,
            "8de4a348191244512a01a726d7d506b7c0c56de5a42806949ea776f9f068c7db"
        );
    }

    #[test]
    fn matches_legacy_precision_subnormal_and_max_hash() {
        let body: Value = serde_json::from_str(
            r#"{"value":9007199254740992,"tiny":5e-324,"max":1.7976931348623157e+308}"#,
        )
        .unwrap();
        assert_eq!(
            stable_json(&body).unwrap(),
            r#"{"max":1.7976931348623157e+308,"tiny":5e-324,"value":9007199254740992}"#
        );
        assert_eq!(
            content_ref("payload", &body).unwrap().sha256,
            "7b81188c0670f0deb92888ab8fc2ada6718ddcd0fb1706d8fdc0ed6dd12114ef"
        );
    }

    #[test]
    fn matches_legacy_basic_final_reference() {
        let body = serde_json::json!({"turnId":"synthetic-turn","contentSha256":"synthetic-content-hash","route":"direct","disposition":"completed","content":"완료"});
        let reference = content_ref("payload", &body).unwrap();
        assert_eq!(
            reference.sha256,
            "2acd7f13d03bbd3865e091b7fa5d06d5bdb3a1dfd0ad50ddeb2fc6fe2b364a57"
        );
        assert_eq!(
            reference.id,
            "33a3d6b41d64603a4a62424868478edce7fe9e5f82dd09e10891de74ae6a3b40"
        );
    }

    #[test]
    fn matches_legacy_integer_property_enumeration() {
        let body: Value = serde_json::from_str(
            r#"{"10":"ten","2":"two","1":"one","01":"leading","4294967294":"index","4294967295":"ordinary","nested":{"12":true,"3":false}}"#,
        ).unwrap();
        assert_eq!(
            sqlite_stable_json(&body).unwrap(),
            r#"{"1":"one","2":"two","10":"ten","4294967294":"index","01":"leading","4294967295":"ordinary","nested":{"3":false,"12":true}}"#,
        );
        assert_eq!(
            digest(&sqlite_stable_json(&body).unwrap()),
            "31a02f5e54218c1e52cffc2c9dcd448216de97e2feb5754965d9abe06754c14d",
        );
        assert_eq!(
            stable_json(&body).unwrap(),
            r#"{"01":"leading","1":"one","10":"ten","2":"two","4294967294":"index","4294967295":"ordinary","nested":{"12":true,"3":false}}"#,
        );
        assert_eq!(
            digest(&stable_json(&body).unwrap()),
            "bbdae394c46f50030ebf2c8d8ccbd8032c031e1890a461b0713cc83ca853eae8",
        );
    }
}
