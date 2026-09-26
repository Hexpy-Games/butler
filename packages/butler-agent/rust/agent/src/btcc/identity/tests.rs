
use super::*;

/// Content references are persisted; canonicalization must keep producing
/// the hashes recorded by the legacy writer.
#[test]
fn persisted_content_ref_hashes_are_stable_across_canonicalization_edge_cases() {
    for (body, canonical, sha256) in [
        (
            r#"{"integerFloat":1.0,"negativeZero":-0.0,"small":1e-7,"threshold":0.000001,"large":1e21,"fixed":100000000000000000000}"#,
            Some(
                r#"{"fixed":100000000000000000000,"integerFloat":1,"large":1e+21,"negativeZero":0,"small":1e-7,"threshold":0.000001}"#,
            ),
            "9e6173e18d3c95286f2a9a7221a1e6e87797e8e5fe3377a6ce884c9c5e20a433",
        ),
        (
            "{\"\u{e000}\":\"bmp\",\"\u{10000}\":\"astral\",\"z\":true}",
            Some("{\"z\":true,\"\u{10000}\":\"astral\",\"\u{e000}\":\"bmp\"}"),
            "4642d265ee2b6b1aa5607ade607a96801ccb3462db93b06db3e185e754040914",
        ),
        (
            "{\"e\u{301}\":\"A\u{30a}\",\"label\":\"e\u{301}\",\"nested\":[\"\\r\\n\",\"\u{2028}\",\"\u{2029}\"]}",
            None,
            "8de4a348191244512a01a726d7d506b7c0c56de5a42806949ea776f9f068c7db",
        ),
        (
            r#"{"value":9007199254740992,"tiny":5e-324,"max":1.7976931348623157e+308}"#,
            Some(r#"{"max":1.7976931348623157e+308,"tiny":5e-324,"value":9007199254740992}"#),
            "7b81188c0670f0deb92888ab8fc2ada6718ddcd0fb1706d8fdc0ed6dd12114ef",
        ),
        (
            r#"{"turnId":"synthetic-turn","contentSha256":"synthetic-content-hash","route":"direct","disposition":"completed","content":"완료"}"#,
            None,
            "2acd7f13d03bbd3865e091b7fa5d06d5bdb3a1dfd0ad50ddeb2fc6fe2b364a57",
        ),
    ] {
        let body: Value = serde_json::from_str(body).unwrap();
        if let Some(canonical) = canonical {
            assert_eq!(stable_json(&body).unwrap(), canonical);
        }
        assert_eq!(content_ref("payload", &body).unwrap().sha256, sha256);
    }
    let reference = content_ref(
            "payload",
            &serde_json::json!({"turnId":"synthetic-turn","contentSha256":"synthetic-content-hash","route":"direct","disposition":"completed","content":"완료"}),
        )
        .unwrap();
    assert_eq!(
        reference.id,
        "33a3d6b41d64603a4a62424868478edce7fe9e5f82dd09e10891de74ae6a3b40"
    );
    // NFC-equivalent bodies with different key order share one reference.
    assert_eq!(
        content_ref("payload", &serde_json::json!({"z": 1, "label": "e\u{301}"})).unwrap(),
        content_ref("payload", &serde_json::json!({"label": "é", "z": 1})).unwrap()
    );
}

#[test]
fn sqlite_identity_uses_js_property_enumeration_order() {
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
        digest(&stable_json(&body).unwrap()),
        "bbdae394c46f50030ebf2c8d8ccbd8032c031e1890a461b0713cc83ca853eae8",
    );
}
