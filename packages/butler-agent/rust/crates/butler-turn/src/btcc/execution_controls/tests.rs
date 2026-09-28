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
