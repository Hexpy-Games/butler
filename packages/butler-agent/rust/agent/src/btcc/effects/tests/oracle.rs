use super::*;

#[test]
fn batch_recovery_preserves_file_hash_consistency_and_path_order() {
    let before = "a".repeat(64);
    let after = "b".repeat(64);
    let entries = json!([
        {"path":"src\\main.rs","startLine":1,"beforeSha256":before.to_uppercase(),"afterSha256":after},
        {"path":"src/main.rs","startLine":3,"beforeSha256":before,"afterSha256":after}
    ]);
    let normalized = super::recovery::normalize_entries(&entries).unwrap();
    assert_eq!(normalized[0].path, "src/main.rs");
    assert_eq!(normalized[1].start_line, 3);
    assert_eq!(normalized[0].before_sha256, before);
    let mut conflict = entries;
    conflict[1]["afterSha256"] = json!("c".repeat(64));
    assert!(super::recovery::normalize_entries(&conflict).is_err());
}

#[test]
fn actual_bun_effect_identity_and_json_bytes_match() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../bun-golden.json")).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let input = &case["input"];
        let binding = if input["reviewedPlanBinding"] == "accepted_plan" {
            PlanBinding::AcceptedPlan
        } else {
            PlanBinding::ExactAction
        };
        let value = super::identity::build_identity(super::identity::IdentityParts {
            work_id: input["workId"].as_str().unwrap(),
            plan_revision_id: input["planRevisionId"].as_str().unwrap(),
            action_key: input["actionKey"].as_str().unwrap(),
            binding,
            occurrence: input
                .get("occurrenceId")
                .and_then(serde_json::Value::as_str),
            capability: input["capability"].as_str().unwrap(),
            normalized_target: input["normalizedTarget"].as_str().unwrap(),
            sanitized_target: input["sanitizedTarget"].as_str().unwrap(),
            normalized_input: &input["normalizedInput"],
        })
        .unwrap();
        assert_eq!(serde_json::to_value(value).unwrap(), case["identity"]);
        assert_eq!(
            super::identity::stable(&input["normalizedInput"]).unwrap(),
            case["inputJson"].as_str().unwrap()
        );
    }
}

#[test]
fn actual_bun_recovery_path_boundaries_match() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../bun-golden.json")).unwrap();
    for case in fixture["recoveryPaths"].as_array().unwrap() {
        let path = case["path"].as_str().unwrap();
        let entry = json!({"path":path,"startLine":1,"beforeSha256":"a".repeat(64),"afterSha256":"b".repeat(64)});
        let actual = super::recovery::normalize_entries(&json!([entry.clone(), entry]));
        if let Some(expected) = case["normalized"].as_str() {
            assert_eq!(actual.unwrap()[0].path, expected, "path={path:?}");
        } else {
            assert_eq!(
                actual.unwrap_err().message,
                case["error"].as_str().unwrap(),
                "path={path:?}"
            );
        }
    }
}
