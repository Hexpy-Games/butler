use super::*;

fn scope() -> WorkTurnScope {
    WorkTurnScope {
        turn_id: "turn".into(),
        session_id: "session".into(),
        project_ref: None,
    }
}

fn action(key: &str) -> PlanAction {
    PlanAction {
        action_key: key.into(),
        description: "do it".into(),
        dependency_keys: vec![],
        effect: None,
    }
}

#[test]
fn plan_requires_objective_and_existing_non_self_dependencies() {
    assert_eq!(
        required_text("  ", "objective").unwrap_err().message(),
        "Durable Work requires objective"
    );
    let mut missing = action("a");
    missing.dependency_keys = vec!["missing".into()];
    let input = ReplacePlanInput {
        scope: scope(),
        mutation_call_id: "call".into(),
        start_new: None,
        backfill_tool_call_ids: None,
        objective: "objective".into(),
        governing_refs: None,
        execution_mode: None,
        actions: vec![missing],
        checks: vec![],
    };
    assert_eq!(
        validate_replace(&input).unwrap_err().message(),
        "Durable Work action dependency is missing: a -> missing"
    );
    let mut self_dep = action("a");
    self_dep.dependency_keys = vec!["a".into()];
    let input = ReplacePlanInput {
        actions: vec![self_dep],
        ..input
    };
    assert_eq!(
        validate_replace(&input).unwrap_err().message(),
        "Durable Work action cannot depend on itself: a"
    );
}

#[test]
fn disposition_rejects_invalid_generation_and_accepts_valid_hex() {
    let mut input = DispositionInput {
        scope: scope(),
        mutation_call_id: "call".into(),
        work_id: "work".into(),
        disposition: DispositionStatus::Open,
        summary: "summary".into(),
        action_updates: None,
        remaining_actions: None,
        next_condition: None,
        evidence_refs: None,
        followups: None,
        backfill_tool_call_ids: None,
        expected_material_fingerprint: Some("a".repeat(64)),
        runtime_owned_open_generation: Some(
            crate::btcc::work::contracts::RuntimeOwnedOpenGeneration { version: 1 },
        ),
    };
    assert!(validate_disposition(&input).is_ok());
    input.expected_material_fingerprint = Some("z".repeat(64));
    assert_eq!(
        validate_disposition(&input).unwrap_err().message(),
        "Durable Work expected material fingerprint is invalid"
    );
    input.expected_material_fingerprint = None;
    assert_eq!(
        validate_disposition(&input).unwrap_err().message(),
        "Runtime-owned open requires its material generation"
    );
}
