//! Exact operation facts shown only to the person deciding the request.
use super::ApprovalFacts;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApprovalOperation {
    pub tool: String,
    pub access: String,
    pub targets: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_conversation: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_site: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    /// In-memory desktop media binding, never a display target.
    pub browser_tab: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub browser_steps: Vec<BrowserApprovalStep>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sign_in_step: Option<String>,
    /// Why `browser_wait_for_user` hands the tab to the user.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<ImageApprovalOperation>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageApprovalOperation {
    pub action: String,
    pub model: String,
    pub model_ref: String,
    pub size: String,
    pub quality: String,
    pub images: Vec<String>,
    pub mask: Option<String>,
    pub prompt: String,
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
    if let Some(operation) = signed_in_operation(&facts).or_else(|| pay_operation(&facts)) {
        return operation;
    }
    if matches!(facts.capability, "browser_act" | "browser_open")
        || matches!(facts.capability, "browser_close" | "browser_observe")
            && facts.input.get("dialog").is_some()
    {
        return browser_operation(facts);
    }
    if facts.capability == "browser_wait_for_user" {
        return wait_operation(&facts);
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
            .map(
                |path| match super::inside_workspace(path, facts.workspace) {
                    Some(relative) if relative.is_empty() => {
                        super::workspace_label(facts.workspace)
                    }
                    Some(relative) => relative,
                    None => super::absolute_target(path, facts.workspace),
                },
            )
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
        // R5 web requests are never covered by a standing permission.
        allow_conversation: matches!(
            facts.capability,
            "web_read"
                | "web_search"
                | "generate_image"
                | "edit_image"
                | butler_core::hooks::PROJECT_HOOKS_CAPABILITY
        )
        .then_some(false),
        allow_site: facts.input["allow_site"].as_str().map(str::to_owned),
        browser_tab: None,
        browser_mode: None,
        browser_steps: Vec::new(),
        sign_in_step: None,
        wait_reason: None,
        image: image_operation(&facts),
    }
}

fn image_operation(facts: &ApprovalFacts<'_>) -> Option<ImageApprovalOperation> {
    if !matches!(facts.capability, "generate_image" | "edit_image") {
        return None;
    }
    serde_json::from_value(facts.input.clone()).ok()
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
    let site = facts.input["merchant_site"].as_str().unwrap_or_else(|| {
        facts
            .target
            .strip_prefix("browser:signed_out:")
            .or_else(|| facts.target.strip_prefix("browser:signed_in:"))
            .unwrap_or(facts.target)
    });
    let mut targets = vec![site.to_owned()];
    if let Some(url) = facts.input["url"].as_str() {
        targets.push(url.into());
    }
    targets.extend(
        facts.input["urls"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned),
    );
    targets.dedup();
    let browser_steps = browser_steps(facts.input);
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
        allow_site: facts.input["allow_site"].as_str().map(str::to_owned),
        browser_tab: facts.input["tab"].as_str().map(str::to_owned),
        browser_mode: facts.input["mode"].as_str().map(str::to_owned),
        browser_steps,
        sign_in_step: None,
        wait_reason: None,
        image: None,
    }
}

fn browser_steps(input: &Value) -> Vec<BrowserApprovalStep> {
    input["resolved_steps"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(index, step)| {
            let hit = &step["hit"];
            let declared = input
                .get("steps")
                .and_then(|steps| steps.get(index))
                .unwrap_or(&Value::Null);
            BrowserApprovalStep {
                action: step["action"]
                    .as_str()
                    .or_else(|| declared["action"].as_str())
                    .unwrap_or("")
                    .into(),
                role: hit["role"].as_str().unwrap_or("").into(),
                name: hit["name"].as_str().unwrap_or("").into(),
                frame: hit["frame"].as_str().unwrap_or("").into(),
                value_preview: step["value_preview"]
                    .as_str()
                    .or_else(|| declared["value"].as_str())
                    .map(str::to_owned),
                addons: step["addons"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect(),
            }
        })
        .collect()
}

/// Signed-in site grants, sign-in fills and the sign-in hand-back wait: one
/// exact card each, never a standing conversation permission.
fn signed_in_operation(facts: &ApprovalFacts<'_>) -> Option<ApprovalOperation> {
    let input = facts.input;
    let text = |value: &Value| value.as_str().unwrap_or("").to_owned();
    let (tool, access, targets) = if let Some(grant) = input.get("grant") {
        ("browser_site_access", "change", vec![text(&grant["site"])])
    } else if let Some(sign_in) = input.get("sign_in") {
        let target = format!(
            "{} · {}",
            text(&sign_in["site"]),
            text(&sign_in["username"])
        );
        ("browser_sign_in", "change", vec![target])
    } else if facts.capability == "browser_sign_in" && input.get("wait").is_some() {
        let targets = vec![text(input.pointer("/wait/site").unwrap_or(&Value::Null))];
        ("browser_sign_in_wait", "read_only", targets)
    } else {
        return None;
    };
    Some(ApprovalOperation {
        tool: tool.into(),
        access: access.into(),
        targets,
        command: None,
        allow_conversation: Some(false),
        allow_site: facts.input["allow_site"].as_str().map(str::to_owned),
        browser_tab: facts.input["tab"].as_str().map(str::to_owned),
        browser_mode: (access == "change").then(|| "signed_in".into()),
        sign_in_step: (tool == "browser_sign_in_wait")
            .then(|| text(input.pointer("/wait/reason").unwrap_or(&Value::Null))),
        wait_reason: None,
        image: None,
        browser_steps: Vec::new(),
    })
}

/// Saved card and autofill fills: the merchant origin (with the amount when
/// the page shows one), the item by nickname and last four, and any payment
/// window origin; the hand-back wait names the site and the step. One exact
/// card each, never a standing conversation permission.
fn pay_operation(facts: &ApprovalFacts<'_>) -> Option<ApprovalOperation> {
    if !matches!(
        facts.capability,
        "browser_pay_fill" | "browser_autofill_fill"
    ) {
        return None;
    }
    let input = facts.input;
    let text = |value: &Value| value.as_str().unwrap_or("").to_owned();
    let (tool, access, targets, wait_reason) = if let Some(pay) = input.get("pay") {
        let merchant = text(&pay["merchant"]);
        let mut place = merchant.clone();
        if let Some(amount) = pay["amount"].as_str().filter(|a| !a.is_empty()) {
            place = format!("{place} · {amount}");
        }
        let mut targets = vec![place, text(&pay["label"])];
        let windows =
            std::iter::once(&pay["top"]).chain(pay["frames"].as_array().into_iter().flatten());
        for origin in windows.filter_map(Value::as_str) {
            if origin != merchant && !targets.iter().any(|t| t == origin) && targets.len() < 5 {
                targets.push(origin.to_owned());
            }
        }
        if let Some(fields) = pay["fields"].as_array() {
            targets.push(
                fields
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(", "),
            );
        }
        (facts.capability, "change", targets, None)
    } else if input.get("wait").is_some() {
        let site = text(input.pointer("/wait/site").unwrap_or(&Value::Null));
        let reason = text(input.pointer("/wait/reason").unwrap_or(&Value::Null));
        ("browser_pay_wait", "read_only", vec![site], Some(reason))
    } else {
        return None;
    };
    Some(ApprovalOperation {
        tool: tool.into(),
        access: access.into(),
        targets,
        command: None,
        allow_conversation: Some(false),
        allow_site: facts.input["allow_site"].as_str().map(str::to_owned),
        browser_tab: facts.input["tab"].as_str().map(str::to_owned),
        browser_mode: None,
        browser_steps: Vec::new(),
        sign_in_step: None,
        wait_reason,
        image: None,
    })
}

/// `browser_wait_for_user`: the site and why, never the tab id; the
/// hand-back matches the request's stored target.
fn wait_operation(facts: &ApprovalFacts<'_>) -> ApprovalOperation {
    let input = facts.input;
    let site = input.pointer("/wait/site").and_then(Value::as_str);
    ApprovalOperation {
        tool: facts.capability.into(),
        access: "read_only".into(),
        targets: site
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .into_iter()
            .collect(),
        command: None,
        allow_conversation: Some(false),
        allow_site: facts.input["allow_site"].as_str().map(str::to_owned),
        browser_tab: facts.input["tab"].as_str().map(str::to_owned),
        browser_mode: None,
        browser_steps: Vec::new(),
        sign_in_step: None,
        image: None,
        wait_reason: input
            .pointer("/wait/reason")
            .and_then(Value::as_str)
            .map(str::to_owned),
    }
}
