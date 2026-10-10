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
                "targets": [{"kind": "outside", "path": ""}]}),
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
    for tool in ["project_ledger_work_complete", "complete_project_work"] {
        assert_eq!(
            summary(tool, "x", &json!({}))["action_kind"],
            "update_project",
            "{tool}"
        );
    }
    assert_path_and_example_bounds();
    super::command_risk::pinned::assert_command_risks();
}

fn assert_path_and_example_bounds() {
    for path in [
        "/etc/hosts",
        "../hosts",
        "app/../../hosts",
        "/Users/someone/work/garden/../hosts",
    ] {
        let actual = summary("write_file", path, &json!({"path": path}));
        assert_eq!(actual["risk"], "high");
        assert_eq!(
            actual["targets"][1],
            json!({"kind": "outside", "path": path})
        );
        assert_eq!(actual["examples"][0], path);
        let command = summary("run_command", "x", &json!({"command": "ls", "cwd": path}));
        assert_eq!(command["risk"], "high");
        assert_eq!(command["targets"][0]["kind"], "outside");
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
        assert!(!operation.to_string().contains("private-tab-id"));
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
        assert!(!operation.to_string().contains("private-tab-id"));
        let stored = summary("browser_wait_for_user", "private-tab-id", &input);
        assert_eq!(stored["targets"][0]["path"], "private-tab-id");
    }
}
