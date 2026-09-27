use std::collections::{BTreeSet, HashMap};

use serde_json::Value;

use super::super::contracts::{ModelRoundMessage, ModelRoundRole};

const PLAN: &[&str] = &["replace_work_plan"];
const WORK: &[&str] = &[
    "start_work",
    "continue_work",
    "record_work_checkpoint",
    "record_work_review",
    "record_work_disposition",
];
const REVIEW: &[&str] = &["record_work_review"];

pub(crate) fn latest_work_anchor_indices(messages: &[ModelRoundMessage]) -> BTreeSet<usize> {
    let mut calls: HashMap<&str, String> = HashMap::new();
    for message in messages {
        for call in message.tool_calls.as_deref().unwrap_or(&[]) {
            let arguments = serde_json::from_str::<Value>(&call.raw_arguments)
                .ok()
                .and_then(|value| match value {
                    Value::Object(arguments) => Some(arguments),
                    _ => None,
                })
                .unwrap_or_default();
            let normalized =
                crate::tool_protocol::normalize_guided_tool_call(&call.name, &arguments);
            calls.insert(call.id.as_str(), normalized.name.into_owned());
        }
    }
    let mut latest = [None, None, None];
    for (index, message) in messages.iter().enumerate() {
        if message.role != ModelRoundRole::Tool || !succeeded(&message.content) {
            continue;
        }
        let name = message
            .tool_call_id
            .as_deref()
            .and_then(|id| calls.get(id).map(String::as_str))
            .or(message.name.as_deref())
            .unwrap_or("");
        for (slot, tools) in [PLAN, WORK, REVIEW].iter().enumerate() {
            if tools.contains(&name) {
                latest[slot] = Some(index);
            }
        }
    }
    latest.into_iter().flatten().collect()
}

fn succeeded(content: &str) -> bool {
    serde_json::from_str::<Value>(content)
        .ok()
        .is_some_and(|value| {
            value.as_object().and_then(|object| object.get("ok")) == Some(&Value::Bool(true))
        })
}
