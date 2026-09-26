use super::*;

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures.json")).unwrap()
}

#[test]
fn creation_matches_actual_legacy_controls_and_signature() {
    let controls = ExecutionControls::create(
        "turn-golden",
        "session-golden",
        ControlResolution {
            model: "openai/gpt".into(),
            reasoning_effort: ReasoningEffort::High,
            access_mode: AccessMode::ReadOnly,
            plan_mode: false,
            source: ControlSource::MessageOverride,
            session_control_revision: 3,
            catalog_generation: "catalog".into(),
            model_fallback: Some(ModelFallback {
                enabled: true,
                models: vec!["anthropic/model".into()],
            }),
            subsession_result: Some(SubsessionResultContext {
                relation_id: " relation ".into(),
                result_id: "result".into(),
                safe_title: "Atlas  보고".into(),
            }),
        },
        "2026-09-14T00:00:00.000Z",
    )
    .unwrap();
    assert_eq!(controls.as_json(), &fixture()["created"]);
    assert_eq!(
        json_stringify_without(controls.as_json(), "integrity_hash").unwrap(),
        fixture()["createdUnsigned"].as_str().unwrap(),
    );
    let verified = controls.verify().unwrap();
    assert_eq!(verified.model_fallback.unwrap().models, ["anthropic/model"]);
    assert_eq!(verified.subsession_result.unwrap().safe_title, "Atlas 보고");
}

#[test]
fn verification_preserves_unknown_fields_original_order_and_non_nfc_text() {
    let value = fixture()["extended"].clone();
    let controls: ExecutionControls = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(
        controls.verify().unwrap().integrity_hash,
        "d1351dca3874fc87d88031be5592d7006750f56f4c6583e94c3483e4661504df",
    );
    assert_eq!(
        json_stringify_without(controls.as_json(), "integrity_hash").unwrap(),
        fixture()["extendedUnsigned"].as_str().unwrap(),
    );
    assert_eq!(serde_json::to_value(&controls).unwrap(), value);
    assert_eq!(controls.as_json()["unknown"], "e\u{301}");

    let mut reordered = value;
    let fields = reordered.as_object_mut().unwrap();
    let unknown = fields.shift_remove("unknown").unwrap();
    fields.insert("unknown".into(), unknown);
    let changed: ExecutionControls = serde_json::from_value(reordered).unwrap();
    assert_eq!(
        changed.verify().unwrap_err().code(),
        "turn_execution_controls_integrity_mismatch",
    );
}

#[test]
fn verification_rejects_invalid_contracts_before_integrity_check() {
    let mut unsafe_title = fixture()["created"].clone();
    unsafe_title["subsession_result"]["safe_title"] = "unsafe\nlabel".into();
    let mut invalid = vec![unsafe_title];
    for field in ["model_fallback", "subsession_result"] {
        let mut value = fixture()["created"].clone();
        value[field] = Value::Null;
        invalid.push(value);
    }
    for value in invalid {
        let controls: ExecutionControls = serde_json::from_value(value).unwrap();
        assert_eq!(
            controls.verify().unwrap_err().code(),
            "turn_execution_controls_invalid"
        );
    }
    let too_long = SubsessionResultContext {
        relation_id: "relation".into(),
        result_id: "result".into(),
        safe_title: "😀".repeat(81),
    };
    assert!(!too_long.valid());
}
