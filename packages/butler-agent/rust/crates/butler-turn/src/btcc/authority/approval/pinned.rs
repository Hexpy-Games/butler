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

/// One summary per action kind, as the App reads them, with no absolute
/// path; then the command-risk table.
pub(in crate::btcc::authority) fn assert_approval_summaries() {
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
                            {"kind": "outside", "path": "passwd"}]}),
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
        assert!(!actual.to_string().contains("/etc/"));
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
