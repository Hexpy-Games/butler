use serde::Deserialize;
use serde_json::Value;

use super::super::{admission, identity, permission};
use super::AuthorityAdmissionInput;
use crate::locale::LocaleCollation;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    locale: String,
    #[serde(rename = "sqliteUtf16Boundary")]
    sqlite_utf16_boundary: String,
    cases: Vec<Case>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    input: Value,
    identity: String,
    normalized_input_json: String,
    reason: String,
    executable: String,
    category: String,
    permission: Value,
    scope: Value,
}
fn str_field(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap().into()
}
fn input(value: &Value) -> AuthorityAdmissionInput {
    AuthorityAdmissionInput {
        public_action_title: value
            .get("publicActionTitle")
            .and_then(Value::as_str)
            .map(str::to_owned),
        owner_session_id: str_field(value, "ownerSessionId"),
        source_session_id: str_field(value, "sourceSessionId"),
        source_turn_id: str_field(value, "sourceTurnId"),
        operation_occurrence_id: value
            .get("operationOccurrenceId")
            .and_then(Value::as_str)
            .map(str::to_owned),
        source_work_id: str_field(value, "sourceWorkId"),
        workspace_path: str_field(value, "workspacePath"),
        plan_revision_id: str_field(value, "planRevisionId"),
        action_key: str_field(value, "actionKey"),
        authority_generation: value["authorityGeneration"].as_i64().unwrap(),
        capability: str_field(value, "capability"),
        target: str_field(value, "target"),
        model_ref: str_field(value, "modelRef"),
        reasoning_effort: str_field(value, "reasoningEffort"),
        category: value
            .get("category")
            .and_then(Value::as_str)
            .map(str::to_owned),
        normalized_input: value["normalizedInput"].clone(),
    }
}

#[test]
fn actual_bun_principal_admission_identity_and_permission_match() {
    let fixture: Fixture = serde_json::from_str(include_str!("../bun-golden.json")).unwrap();
    let collation = LocaleCollation::new(&fixture.locale).unwrap();
    assert_eq!(
        identity::slice_utf16(&("A".repeat(95) + "😀"), 96),
        fixture.sqlite_utf16_boundary
    );
    for case in fixture.cases {
        let input = input(&case.input);
        assert_eq!(
            identity::identity(&input, input.authority_generation, &collation).unwrap(),
            case.identity
        );
        assert_eq!(
            identity::canonical(&input.normalized_input, &collation).unwrap(),
            case.normalized_input_json
        );
        let reviewed = input.category.as_deref() == Some("reviewed_effect");
        assert_eq!(
            case.category,
            if reviewed {
                "reviewed_effect"
            } else {
                "command"
            }
        );
        assert_eq!(
            case.reason,
            input
                .public_action_title
                .as_deref()
                .filter(|value| !value.is_empty())
                .unwrap_or(if reviewed {
                    "Apply one reviewed effect"
                } else {
                    "Run one reviewed command"
                })
        );
        assert_eq!(
            case.executable,
            if reviewed {
                identity::slice_utf16(&input.capability, 96)
            } else {
                admission::first_executable(input.normalized_input["command"].as_str().unwrap())
            }
        );
        let actual = permission::for_admission(&input, &collation).unwrap();
        assert_eq!(actual.grant_ref, case.permission["grantRef"]);
        assert_eq!(actual.scope_key, case.permission["scopeKey"]);
        assert_eq!(actual.title, case.permission["title"]);
        assert_eq!(actual.description, case.permission["description"]);
        assert_eq!(case.scope["title"], actual.title);
    }
}
