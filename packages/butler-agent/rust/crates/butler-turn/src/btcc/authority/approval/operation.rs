//! Exact operation facts shown only to the person deciding the request.
use super::ApprovalFacts;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApprovalOperation {
    pub tool: String,
    pub access: String,
    pub targets: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
}

pub(in crate::btcc::authority) fn exact_operation(facts: ApprovalFacts<'_>) -> ApprovalOperation {
    let input = facts.input;
    let command = input["command"].as_str().map(str::to_owned);
    let paths = match facts.capability {
        "read_file" => paths(input, "requests"),
        "write_file" | "edit_file" => {
            if input["edits"].is_array() {
                paths(input, "edits")
            } else {
                input["path"].as_str().into_iter().collect()
            }
        }
        "list_files" | "grep_files" => vec![input["root"].as_str().unwrap_or(".")],
        "run_command" | "run_command_remote_observation" => {
            vec![input["cwd"].as_str().unwrap_or(".")]
        }
        _ => Vec::new(),
    };
    let targets = if paths.is_empty() {
        vec![facts.target.to_owned()]
    } else {
        paths
            .into_iter()
            .map(|path| {
                if Path::new(path).is_absolute() {
                    path.to_owned()
                } else if path == "." {
                    facts.workspace.to_owned()
                } else {
                    Path::new(facts.workspace)
                        .join(path)
                        .to_string_lossy()
                        .into_owned()
                }
            })
            .collect()
    };
    let read_only = matches!(facts.capability, "read_file" | "list_files" | "grep_files")
        || matches!(
            input["state_effect"].as_str(),
            Some("read_only" | "validation")
        );
    ApprovalOperation {
        tool: facts.capability.into(),
        access: if read_only { "read_only" } else { "change" }.into(),
        targets,
        command,
    }
}

fn paths<'a>(input: &'a Value, key: &str) -> Vec<&'a str> {
    input[key]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| entry["path"].as_str())
        .collect()
}
