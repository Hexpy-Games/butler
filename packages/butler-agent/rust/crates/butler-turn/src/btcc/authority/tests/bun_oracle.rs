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
        honor_standing_permission: true,
        unattended: false,
    }
}

/// Format pin: what each admission projects (identity, permission scope)
/// matches the Bun oracle, and every approval summary and command risk is
/// as the App reads it.
// test-category: pure-logic
#[test]
fn actual_bun_principal_admission_identity_and_permission_match() {
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
    }
    site_data_grant_is_separate_from_commits(&collation);
}

/// Opening, reading and typing share one per-site grant; commits keep theirs.
fn site_data_grant_is_separate_from_commits(collation: &LocaleCollation) {
    let admission = |capability: &str, target: &str, normalized: Value| {
        let case = json!({"ownerSessionId":"s","sourceSessionId":"s","sourceTurnId":"t",
            "sourceWorkId":"","workspacePath":"/w","planRevisionId":"","actionKey":"a",
            "authorityGeneration":1,"capability":capability,"target":target,"modelRef":"m",
            "reasoningEffort":"medium","category":"reviewed_effect","normalizedInput":normalized});
        permission::for_admission(&input(&case), collation).unwrap()
    };
    let site = "browser:signed_out:example.com";
    let open = |capability: &str, url: &str, data_site: &str| {
        admission(
            capability,
            url,
            json!({"navigation":true,"urls":[url],
            "data_site":data_site,"arguments":{"url":url},
            "resolved_steps":[{"action":"navigate","value_preview":url}]}),
        )
    };
    let act = |steps: Value, commit: bool| {
        admission(
            "browser_act",
            site,
            json!({"tab":"t","steps":steps,"commit":commit,
            "always_confirm":false,"data_site":site}),
        )
    };
    let opened = open("browser_open", "https://www.example.com/a?hl=en", site);
    let typed = act(
        json!([{"action":"click","ref":"e1"},{"action":"type","value":"x"}]),
        false,
    );
    let committed = act(json!([{"action":"click","ref":"e2","commits":true}]), true);
    let clicked = act(json!([{"action":"click","ref":"e3"}]), false);
    assert_eq!(opened.target, site);
    // Navigation and typing on one site share a grant.
    assert_eq!(
        open("browser_read", "https://shop.example.com/b?q=1", site).grant_ref,
        opened.grant_ref
    );
    assert_eq!(typed.grant_ref, opened.grant_ref);
    // Neither covers commits, and a commit grant covers neither.
    assert_ne!(committed.grant_ref, opened.grant_ref);
    assert_ne!(committed.grant_ref, typed.grant_ref);
    // Commit and plain act grants keep today's browser_act key.
    assert_eq!(committed.grant_ref, clicked.grant_ref);
    assert_ne!(
        open(
            "browser_open",
            "https://www.example.org/a",
            "browser:signed_out:example.org"
        )
        .grant_ref,
        opened.grant_ref
    );
}
