//! Source English activity copy and public argument projection.

use serde_json::{Value, json};

use crate::btcc::{ModelRoundToolCall, WorkStage, WorkView};
use crate::public_text::{sanitize_public_text, sanitize_public_value};

pub(super) struct Content {
    pub title: String,
    pub summary: String,
    pub stage: Option<WorkStage>,
    pub next_step: Option<String>,
    pub interface_content: Option<Value>,
    pub next_execution_title: Option<String>,
}

pub(super) fn activity_kind(name: &str) -> &'static str {
    match name {
        "start_work" | "continue_work" => "work_selection",
        "replace_work_plan" => "plan",
        "record_work_review" => "review",
        "record_work_checkpoint" => "checkpoint",
        _ => "ordinary",
    }
}

pub(super) fn content(
    first: &ModelRoundToolCall,
    calls: &[&ModelRoundToolCall],
    assistant_text: &str,
) -> Content {
    let args = &first.arguments;
    let name = first.name.as_str();
    if matches!(name, "start_work" | "continue_work") {
        let continuing = name == "continue_work";
        let title = tool_title(name, args);
        let summary = if continuing {
            "Checking previous work and its current state."
        } else {
            "Clarifying the request and required outcome."
        };
        let key = if continuing {
            "checkingPrevious"
        } else {
            "checkingRequest"
        };
        return Content {
            title,
            summary: summary.into(),
            stage: (!continuing).then_some(WorkStage::Conception),
            next_step: None,
            interface_content: Some(json!({"title":title_ref(name,args),"summary":{"key":key}})),
            next_execution_title: None,
        };
    }
    if name == "replace_work_plan" {
        let title = tool_title(name, args);
        let summary = public(args.get("objective"))
            .or_else(|| public_str(assistant_text))
            .unwrap_or_else(|| title.clone());
        let missing_authored =
            public(args.get("objective")).is_none() && public_str(assistant_text).is_none();
        let mut interface = json!({"title":title_ref(name,args)});
        if missing_authored {
            interface["summary"] = title_ref(name, args);
        }
        return Content {
            title,
            summary,
            stage: Some(WorkStage::Planning),
            next_step: first_plan_action(args),
            interface_content: Some(interface),
            next_execution_title: None,
        };
    }
    if name == "record_work_review" {
        let title = tool_title(name, args);
        let summary = public(args.get("summary"))
            .or_else(|| public_str(assistant_text))
            .unwrap_or_else(|| title.clone());
        let missing_authored =
            public(args.get("summary")).is_none() && public_str(assistant_text).is_none();
        let mut interface = json!({"title":title_ref(name,args)});
        if missing_authored {
            interface["summary"] = title_ref(name, args);
        }
        return Content {
            title,
            summary,
            stage: Some(
                if args.get("subject").and_then(Value::as_str) == Some("completion") {
                    WorkStage::Validation
                } else {
                    WorkStage::Review
                },
            ),
            next_step: args
                .get("corrections")
                .and_then(Value::as_array)
                .and_then(|items| items.iter().find_map(|item| public(Some(item)))),
            interface_content: Some(interface),
            next_execution_title: active_action_title(args),
        };
    }
    if name == "record_work_checkpoint" {
        let title = tool_title(name, args);
        let summary = public(args.get("public_summary"))
            .or_else(|| public_str(assistant_text))
            .unwrap_or_else(|| title.clone());
        let missing_authored =
            public(args.get("public_summary")).is_none() && public_str(assistant_text).is_none();
        let mut interface = json!({"title":title_ref(name,args)});
        if missing_authored {
            interface["summary"] = title_ref(name, args);
        }
        let active = active_action_title(args);
        return Content {
            title: active.clone().unwrap_or(title),
            summary,
            stage: Some(WorkStage::Execution),
            next_step: public(args.get("next_step")),
            interface_content: Some(interface),
            next_execution_title: None,
        };
    }
    let titles: Vec<String> = calls
        .iter()
        .map(|call| tool_title(&call.name, &call.arguments))
        .collect();
    let unique = titles.iter().collect::<std::collections::HashSet<_>>();
    let title = if unique.len() == 1 {
        titles
            .first()
            .cloned()
            .unwrap_or_else(|| "Tool work".into())
    } else {
        "Tool work".into()
    };
    let grouped = titles
        .iter()
        .fold(Vec::<&str>::new(), |mut seen, title| {
            if !seen.contains(&title.as_str()) {
                seen.push(title.as_str());
            }
            seen
        })
        .join(" · ");
    let fallback = format!("Checking the required information with {grouped}.");
    let authored = public_str(assistant_text);
    let summary = authored.unwrap_or_else(|| fallback.clone());
    let summary = distinct(
        &title,
        &summary,
        "Checking information needed for the work.",
    );
    let tools = calls
        .iter()
        .map(|call| {
            let reference = title_ref(&call.name, &call.arguments);
            let parameters = &reference["parameters"];
            let mut item = json!({"name":parameters["toolName"]});
            if let Some(target) = parameters.get("target") {
                item["target"] = target.clone();
            }
            item
        })
        .collect::<Vec<_>>();
    let mut interface = json!({
        "title":if unique.len()==1 { title_ref(name,args) }
            else { json!({"key":"toolTitle","parameters":{"toolName":"tool_work"}}) }
    });
    if public_str(assistant_text).is_none() {
        interface["summary"] = json!({"key":"toolsSummary","parameters":{"tools":tools}});
    }
    Content {
        title,
        summary,
        stage: None,
        next_step: None,
        interface_content: Some(interface),
        next_execution_title: None,
    }
}

pub(super) fn conception(plan_summary: &str) -> Content {
    Content {
        title: "Confirm request intent".into(),
        summary: format!("Confirmed the request goal and scope: {plan_summary}"),
        stage: Some(WorkStage::Conception),
        next_step: Some("Define the work order and validation criteria for the request.".into()),
        interface_content: Some(json!({
            "title":{"key":"conceptionTitle"},
            "summary":{"key":"conceptionSummary","parameters":{"text":plan_summary}},
            "nextStep":{"key":"planningNext"}
        })),
        next_execution_title: None,
    }
}

pub(super) fn reporting(text: &str) -> Option<Content> {
    let text = public_str(text)?;
    Some(Content {
        title: "Report results".into(),
        summary: distinct(
            "Report results",
            &text,
            "Checking information needed for the work.",
        ),
        stage: Some(WorkStage::Reporting),
        next_step: None,
        interface_content: Some(json!({"title":{"key":"reportTitle"}})),
        next_execution_title: None,
    })
}

pub(super) fn resumed(work: &WorkView) -> Content {
    let active = work
        .action_progress
        .iter()
        .find(|progress| progress.status == crate::btcc::ActionStatus::Active)
        .and_then(|progress| {
            work.current_plan
                .as_ref()?
                .actions
                .iter()
                .find(|action| action.action_key == progress.action_key)
        });
    let title = active
        .map(|action| {
            work_action_display(
                &action.action_key,
                &action.description,
                action
                    .effect
                    .as_ref()
                    .and_then(|effect| effect.get("target"))
                    .and_then(Value::as_str),
                if action.description.is_empty() {
                    "Check progress"
                } else {
                    &action.description
                },
            )
        })
        .unwrap_or_else(|| "Check progress".into());
    let summary = work
        .latest_checkpoint
        .as_ref()
        .and_then(|item| public_str(&item.public_summary))
        .or_else(|| active.and_then(|action| public_str(&action.description)))
        .or_else(|| public_str(&work.objective))
        .unwrap_or_default();
    Content {
        title: bounded(&title),
        summary,
        stage: work.current_stage,
        next_step: None,
        interface_content: active
            .is_none()
            .then(|| json!({"title":title_ref("continue_work", &serde_json::Map::new())})),
        next_execution_title: None,
    }
}

fn first_plan_action(args: &serde_json::Map<String, Value>) -> Option<String> {
    args.get("actions")?.as_array()?.iter().find_map(|action| {
        let key = public(action.get("action_key"));
        let description = public(action.get("description"));
        let target = public(action.get("effect").and_then(|effect| effect.get("target")));
        let key = key?;
        Some(work_action_display(
            &key,
            description.as_deref().unwrap_or(""),
            target.as_deref(),
            description.as_deref().unwrap_or(&key),
        ))
    })
}

fn active_action_title(args: &serde_json::Map<String, Value>) -> Option<String> {
    args.get("action_updates")?
        .as_array()?
        .iter()
        .find_map(|update| {
            if update.get("status")?.as_str()? != "active" {
                return None;
            }
            let key = public(update.get("action_key"))?;
            Some(work_action_display(&key, "", None, &key))
        })
}

#[expect(
    clippy::match_same_arms,
    reason = "explicit arms document the known values beside the default"
)]
fn tool_title(name: &str, args: &serde_json::Map<String, Value>) -> String {
    let label = match name {
        "start_work" => "Check request",
        "continue_work" => "Check progress",
        "replace_work_plan" => "Plan execution",
        "record_work_checkpoint" => "Check work progress",
        "record_work_review" => match args.get("subject").and_then(Value::as_str) {
            Some("plan") => "Review plan",
            Some("completion") => "Review completion",
            _ => "Review results",
        },
        "record_work_disposition" => "Record completion",
        "read_file" => "Read file",
        "query_memory" => "Use tool",
        "read_conversation_session" => "Use tool",
        _ => "Use tool",
    };
    if let Some(target) = safe_file_target(name, args) {
        format!("{label}: {target}")
    } else {
        label.into()
    }
}

fn title_ref(name: &str, args: &serde_json::Map<String, Value>) -> Value {
    let name = if name == "record_work_review" {
        match args.get("subject").and_then(Value::as_str) {
            Some("plan") => "plan_review",
            Some("completion") => "completion_review",
            _ => name,
        }
    } else {
        name
    };
    let mut parameters = json!({"toolName":name});
    if let Some(target) = safe_file_target(name, args) {
        parameters["target"] = json!(target);
    }
    json!({"key":"toolTitle","parameters":parameters})
}

fn safe_file_target(name: &str, args: &serde_json::Map<String, Value>) -> Option<String> {
    if !matches!(name, "read_file" | "write_file" | "edit_file") {
        return None;
    }
    let first = if name == "read_file" {
        args.get("requests")
            .and_then(Value::as_array)
            .and_then(|requests| requests.iter().find_map(Value::as_object))
    } else {
        None
    };
    let value = first
        .and_then(|first| first.get("path"))
        .or_else(|| args.get("path"))
        .or_else(|| args.get("file_path"))
        .or_else(|| args.get("file"))
        .or_else(|| args.get("target"));
    let text = public(value)?;
    let basename = text.trim_end_matches('/').rsplit('/').next().unwrap_or("");
    (!basename.is_empty()).then(|| basename.to_owned())
}

fn public(value: Option<&Value>) -> Option<String> {
    let text = sanitize_public_value(value?, "");
    (!text.is_empty()).then_some(text)
}

fn public_str(value: &str) -> Option<String> {
    let text = sanitize_public_text(value, "");
    (!text.is_empty()).then_some(text)
}

fn distinct(title: &str, summary: &str, fallback: &str) -> String {
    if !title.eq_ignore_ascii_case(summary) {
        summary.into()
    } else if !title.eq_ignore_ascii_case(fallback) {
        fallback.into()
    } else {
        format!("Working on {summary}.")
    }
}

fn bounded(value: &str) -> String {
    value.chars().take(32).collect()
}

fn work_action_display(
    key: &str,
    description: &str,
    target: Option<&str>,
    fallback: &str,
) -> String {
    let key = public_str(key).unwrap_or_default();
    let description = public_str(description).unwrap_or_default();
    if !description.is_empty()
        && description != key
        && generic_key(&key)
        && !generic_key(&description)
    {
        return compact(&description);
    }
    if generic_key(&key)
        && let Some(target) = target.and_then(public_str)
    {
        return compact(&target);
    }
    compact(&public_str(fallback).unwrap_or_default())
}

fn generic_key(key: &str) -> bool {
    if matches!(
        key,
        "inspect" | "plan" | "implement" | "validate" | "release" | "closeout"
    ) {
        return true;
    }
    let normalized = key
        .bytes()
        .all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'_' | b'-'));
    normalized && (key.contains('_') || key.contains('-'))
}

fn compact(value: &str) -> String {
    let chars = value.chars().collect::<Vec<_>>();
    if chars.len() <= 32 {
        return value.into();
    }
    let prefix = chars[..31].iter().collect::<String>();
    let cut = prefix
        .rfind(' ')
        .filter(|index| *index >= 16)
        .unwrap_or(prefix.len());
    format!("{}…", prefix[..cut].trim_end())
}
