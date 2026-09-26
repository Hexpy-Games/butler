use serde_json::{Map, Value, json};

use super::binding;
use crate::workspace::session_recovery::authority::{
    SessionWorkspaceAuthority, public_workspace_label, resolve_authority, safe_workspace_basename,
};
use crate::workspace::session_recovery::path::parse_worktrees;

fn authority_json(authority: SessionWorkspaceAuthority) -> Value {
    match authority {
        SessionWorkspaceAuthority::Project { workspace_path } => {
            let mut result = json!({"kind":"project"});
            if let Some(path) = workspace_path {
                result["workspacePath"] = Value::String(path);
            }
            result
        }
        SessionWorkspaceAuthority::SessionWorktree {
            workspace_path,
            branch,
            workspace_label,
            marker,
        } => json!({
            "kind":"session_worktree",
            "workspacePath":workspace_path,
            "branch":branch,
            "workspaceLabel":workspace_label,
            "marker":{
                "schema":"butler.session-workspace-binding.v1",
                "ownership":"session",
                "repositoryAnchorPath":marker.repository_anchor_path,
                "branch":marker.branch,
                "boundAt":marker.bound_at,
            },
        }),
        SessionWorkspaceAuthority::Unavailable {
            workspace_path,
            workspace_label,
            error_code,
        } => json!({
            "kind":"unavailable",
            "workspacePath":workspace_path,
            "workspaceLabel":workspace_label,
            "safeErrorCode":error_code,
        }),
    }
}

#[test]
fn actual_bun_authority_parser_and_label_cases() {
    let golden: Value = serde_json::from_str(include_str!("../bun-golden.json")).unwrap();
    for (index, case) in golden["cases"].as_array().unwrap().iter().enumerate() {
        let source_binding = &case["input"]["binding"];
        let binding = source_binding.as_object().map(|source| {
            let metadata = source.get("metadata").and_then(Value::as_object).cloned();
            let mut stored = binding(metadata);
            stored.workspace_path = source["workspacePath"].as_str().unwrap().into();
            stored
        });
        let project = case["input"]["project"].as_str();
        assert_eq!(
            authority_json(resolve_authority(binding.as_ref(), project)),
            case["authority"],
            "authority case {index}"
        );
    }
    for (index, case) in golden["worktrees"].as_array().unwrap().iter().enumerate() {
        let entries = parse_worktrees(case["stdout"].as_str().unwrap()).unwrap();
        let actual: Vec<_> = entries
            .into_iter()
            .map(|entry| {
                let mut value = Map::new();
                value.insert(
                    "path".into(),
                    Value::String(entry.path.to_string_lossy().into_owned()),
                );
                if let Some(head) = entry.head {
                    value.insert("head".into(), Value::String(head));
                }
                if let Some(branch) = entry.branch {
                    value.insert("branch".into(), Value::String(branch));
                }
                Value::Object(value)
            })
            .collect();
        assert_eq!(
            json!(actual),
            case["result"]["entries"],
            "parser case {index}"
        );
    }
    for case in golden["labels"].as_array().unwrap() {
        assert_eq!(
            public_workspace_label(case["branch"].as_str().unwrap()),
            case["label"]
        );
    }
    for case in golden["basenames"].as_array().unwrap() {
        assert_eq!(
            safe_workspace_basename(case["path"].as_str()),
            case["basename"]
        );
    }
}
