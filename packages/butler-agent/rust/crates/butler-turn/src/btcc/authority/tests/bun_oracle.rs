use serde::Deserialize;
use serde_json::{Value, json};

use super::super::{admission, identity, permission};
use super::AuthorityAdmissionInput;
use butler_core::locale::LocaleCollation;

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

/// Format pin: what each admission projects (identity, permission scope)
/// matches the Bun oracle, and every approval summary and command risk is
/// as the App reads it.
// test-category: pure-logic
#[test]
fn actual_bun_principal_admission_identity_and_permission_match() {
    assert_command_scope_bytes();
    super::super::approval::pinned::assert_approval_summaries();
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
        assert_source_permission(&input, &collation, &actual.grant_ref);
    }
}

fn assert_source_permission(
    input: &AuthorityAdmissionInput,
    collation: &LocaleCollation,
    expected: &str,
) {
    let encoded = serde_json::to_string(&input.normalized_input).unwrap();
    let source = super::super::contracts::PermissionSource {
        owner: &input.owner_session_id,
        workspace: &input.workspace_path,
        capability: &input.capability,
        target: &input.target,
        input_json: &encoded,
        created_at: "2000",
        rowid: 1,
    };
    let projected = permission::for_source(
        &source,
        collation,
        &mut Default::default(),
        &permission::CommandScope::new(collation),
    )
    .unwrap();
    assert_eq!(projected.grant_ref, expected);
    let admitted = permission::for_admission(input, collation).unwrap();
    assert_eq!(projected.target, admitted.target);
    assert_eq!(projected.cwd, admitted.cwd);
}

fn assert_command_scope_bytes() {
    for locale in ["en-US", "ko-KR", "tr-TR"] {
        let collation = LocaleCollation::new(locale).unwrap();
        let encoder = permission::CommandScope::new(&collation);
        for input in [
            json!({}),
            json!({"command":"a","state_effect":null,"padding":"validated"}),
            json!({"command":null,"cwd":false,"state_effect":true}),
            json!({"command":"검토\"\\\n","cwd":"e\u{301}","state_effect":"BearER abc"}),
            json!({"command":-0.0,"cwd":1e21,"state_effect":9_007_199_254_740_993_u64}),
            json!({"command":{"z":1,"a":2},"cwd":[null,{}],"state_effect":{"10":1,"2":2,"A":3,"a":4}}),
            json!(["ignored"]),
        ] {
            let mut scope = serde_json::Map::new();
            scope.insert("kind".into(), json!("command"));
            for (key, source) in [
                ("command", "command"),
                ("cwd", "cwd"),
                ("stateEffect", "state_effect"),
            ] {
                if let Some(value) = input.get(source) {
                    scope.insert(key.into(), value.clone());
                }
            }
            let expected =
                identity::digest(&identity::canonical(&Value::Object(scope), &collation).unwrap());
            assert_eq!(encoder.key(&input, &collation).unwrap(), expected);
            let mut admission = super::input("work", "plan");
            admission.normalized_input = input;
            let admitted = permission::for_admission(&admission, &collation).unwrap();
            assert_source_permission(&admission, &collation, &admitted.grant_ref);
        }
    }
}
