use serde_json::json;

use super::*;

#[test]
fn execution_controls_preserve_snake_case_contract() {
    let controls: ExecutionControls = serde_json::from_value(json!({
        "schema_version":"butler.turn-execution-controls.v1",
        "turn_id":"turn-1", "session_id":"session-1", "model_ref":"openai/gpt",
        "reasoning_effort":"high", "access_mode":"read_only", "plan_mode":false,
        "source":"message_override", "session_control_revision":3,
        "catalog_generation":"catalog", "resolved_at":"2026-09-14T00:00:00Z",
        "integrity_hash":"hash", "model_fallback":{"enabled":false,"models":[]}
    }))
    .unwrap();
    let value = serde_json::to_value(controls).unwrap();
    assert_eq!(value["turn_id"], "turn-1");
    assert_eq!(value["reasoning_effort"], "high");
    assert!(value.get("turnId").is_none());
}

#[test]
fn cancelled_outcome_preserves_tag_and_camel_case_payload() {
    let outcome = TurnOutcome {
        result: TurnOutcomeKind::Cancelled {
            turn_id: "turn-1".into(),
        },
        admission: Some(AdmissionKind::Fresh),
    };
    assert_eq!(
        serde_json::to_value(outcome).unwrap(),
        json!({"kind": "cancelled", "turnId": "turn-1", "admission": "fresh"})
    );
}
