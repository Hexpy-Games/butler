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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_conversation: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub browser_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub browser_steps: Vec<BrowserApprovalStep>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowserApprovalStep {
    pub action: String,
    pub role: String,
    pub name: String,
    pub frame: String,
    pub value_preview: Option<String>,
    pub addons: Vec<String>,
}

pub(in crate::btcc::authority) fn exact_operation(facts: ApprovalFacts<'_>) -> ApprovalOperation {
    let input = facts.input;
    if facts.capability == "browser_act"
        || matches!(facts.capability, "browser_close" | "browser_observe")
            && facts.input.get("dialog").is_some()
    {
        return browser_operation(facts);
    }
    if facts.capability == "browser_wait_for_user" {
        return ApprovalOperation {
            tool: facts.capability.into(),
            access: "read_only".into(),
            targets: vec![facts.target.into()],
            command: None,
            allow_conversation: Some(false),
            browser_mode: None,
            browser_steps: Vec::new(),
        };
    }
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
        "run_command" | "run_command_remote_observation" | "preview_start" => {
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
        allow_conversation: None,
        browser_mode: None,
        browser_steps: Vec::new(),
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

fn browser_operation(facts: ApprovalFacts<'_>) -> ApprovalOperation {
    let mut targets = vec![
        facts
            .target
            .strip_prefix("browser:signed_out:")
            .unwrap_or(facts.target)
            .to_owned(),
    ];
    let browser_steps = facts.input["resolved_steps"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|step| {
            let hit = &step["hit"];
            BrowserApprovalStep {
                action: step["action"].as_str().unwrap_or("").into(),
                role: hit["role"].as_str().unwrap_or("").into(),
                name: hit["name"].as_str().unwrap_or("").into(),
                frame: hit["frame"].as_str().unwrap_or("").into(),
                value_preview: step["value_preview"].as_str().map(str::to_owned),
                addons: step["addons"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect(),
            }
        })
        .collect();
    if let Some(dialog) = facts.input.get("dialog") {
        targets.push(format!(
            "{} · \"{}\"",
            dialog["type"].as_str().unwrap_or("dialog"),
            dialog["message"].as_str().unwrap_or("")
        ));
        if dialog["type"] == "prompt" {
            targets.push(format!(
                "→ \"{}\"",
                dialog["defaultPrompt"].as_str().unwrap_or("")
            ));
        }
    }
    ApprovalOperation {
        tool: facts.capability.into(),
        access: "change".into(),
        targets,
        command: None,
        allow_conversation: Some(facts.input["always_confirm"] != true),
        browser_mode: facts.input["mode"].as_str().map(str::to_owned),
        browser_steps,
    }
}
