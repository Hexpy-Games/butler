//! Provider history only: journaled observations and receipts remain immutable.
use super::contracts::{ModelRoundMessage, ModelRoundRole, ModelRoundToolCall};
use serde_json::{Value, json};
use std::collections::HashMap;
mod summary;

// Text snapshots collapse immediately: cached stale snapshots still cost tokens
// and occupy the window. Only the cycle being replaced invalidates the prefix.
const STALE_FULL_BUDGET_BYTES: usize = 0;

struct Cycle {
    obs_index: usize,
    obs_id: String,
    act_indices: Vec<usize>,
    acted: Vec<String>,
}

struct History {
    tabs: HashMap<String, Vec<Cycle>>,
    latest_acts: HashMap<String, usize>,
    acts: Vec<(usize, ModelRoundToolCall, Value)>,
}

fn history(messages: &mut [ModelRoundMessage]) -> History {
    let mut calls = HashMap::new();
    let mut tabs: HashMap<String, Vec<Cycle>> = HashMap::new();
    let mut latest_acts = HashMap::new();
    let mut acts = Vec::new();
    for (index, message) in messages.iter_mut().enumerate() {
        for call in message.tool_calls.iter().flatten() {
            if let Some(call) = browser_call(call) {
                calls.insert(call.id.clone(), call);
            }
        }
        if message.role != ModelRoundRole::Tool {
            continue;
        }
        let call = message.tool_call_id.as_ref().and_then(|id| calls.get(id));
        if call.is_none()
            && !matches!(
                message.name.as_deref(),
                Some("browser_observe" | "browser_act")
            )
        {
            continue;
        }
        let Ok(mut value) = serde_json::from_str::<Value>(&message.content) else {
            continue;
        };
        let Some(output) = value.get_mut("output") else {
            continue;
        };
        let observation = field(output, "schema") == "butler.browser-observation.v1";
        let action = field(output, "schema") == "butler.browser-action.v1";
        if !observation && !action {
            continue;
        }
        message.image_attachments.clear();
        let Some(tab) = field(output, "tab")
            .as_str()
            .or_else(|| call?.arguments.get("tab")?.as_str())
            .map(str::to_owned)
        else {
            continue;
        };
        if observation {
            if let Some(obs_id) = field(output, "obs").as_str() {
                tabs.entry(tab).or_default().push(Cycle {
                    obs_index: index,
                    obs_id: obs_id.into(),
                    act_indices: Vec::new(),
                    acted: Vec::new(),
                });
            }
        } else {
            if strip_desktop_stills(output) {
                message.content = value.to_string().into();
            }
            if let Some(call) = call {
                attach_act(&mut tabs, &tab, index, call, field(&value, "output"));
                latest_acts.insert(tab, index);
                acts.push((index, call.clone(), value));
            }
        }
    }
    History {
        tabs,
        latest_acts,
        acts,
    }
}

pub(super) fn supersede(messages: &mut [ModelRoundMessage]) {
    let History {
        tabs,
        latest_acts,
        acts,
    } = history(messages);
    for cycles in tabs.values() {
        let mut budget = STALE_FULL_BUDGET_BYTES;
        for cycle in cycles.iter().rev().skip(1) {
            let Some(message) = messages.get_mut(cycle.obs_index) else {
                continue;
            };
            if is_superseded(&message.content) {
                continue;
            }
            if message.content.len() <= budget {
                budget -= message.content.len();
                continue;
            }
            message.content = json!({"ok":true,"output":{"schema":"butler.browser-observation.v1","obs":cycle.obs_id,"status":"superseded","acted":cycle.acted.join("; ")}}).to_string().into();
        }
    }
    for (index, call, value) in acts {
        let Some(message) = messages.get_mut(index) else {
            continue;
        };
        if latest_acts.get(
            call.arguments
                .get("tab")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        ) == Some(&index)
            || is_superseded(&message.content)
        {
            continue;
        }
        let output = field(&value, "output");
        message.content = json!({"ok":field(&value, "ok"),"output":{"schema":"butler.browser-action.v1","obs":call.arguments.get("observation"),"status":field(output, "status"),"steps":summary::steps(output),"superseded":true}}).to_string().into();
    }
}

fn attach_act(
    tabs: &mut HashMap<String, Vec<Cycle>>,
    tab: &str,
    index: usize,
    call: &ModelRoundToolCall,
    output: &Value,
) {
    let Some(obs) = call.arguments.get("observation").and_then(Value::as_str) else {
        return;
    };
    if let Some(cycle) = tabs
        .get_mut(tab)
        .and_then(|cycles| cycles.iter_mut().rev().find(|cycle| cycle.obs_id == obs))
    {
        cycle.act_indices.push(index);
        cycle.acted.push(summary::acted(call, output));
    }
}

pub(super) fn is_superseded(content: &str) -> bool {
    serde_json::from_str::<Value>(content).is_ok_and(|v| {
        field(field(&v, "output"), "status") == "superseded"
            || field(field(&v, "output"), "superseded") == true
    })
}

fn strip_desktop_stills(output: &mut Value) -> bool {
    let mut changed = output
        .as_object_mut()
        .is_some_and(|record| record.remove("still_file").is_some());
    if let Some(steps) = output.get_mut("steps").and_then(Value::as_array_mut) {
        for step in steps {
            if let Some(record) = step.as_object_mut() {
                changed |= record.remove("still_file").is_some();
            }
        }
    }
    changed
}

fn browser_call(call: &ModelRoundToolCall) -> Option<ModelRoundToolCall> {
    let native = call.arguments.get("id").and_then(Value::as_str);
    let browser = match call.name.as_str() {
        "browser_observe" | "browser_act" => true,
        "tool_call" => matches!(
            native,
            Some("native:browser_observe" | "native:browser_act")
        ),
        _ => false,
    };
    if !browser {
        return None;
    }
    let arguments: Value = serde_json::from_str(&call.raw_arguments).ok()?;
    let (name, args) = if call.name == "tool_call" {
        (
            arguments.get("id")?.as_str()?.strip_prefix("native:")?,
            arguments.get("arguments")?,
        )
    } else {
        (call.name.as_str(), &arguments)
    };
    if !matches!(name, "browser_observe" | "browser_act") {
        return None;
    }
    let mut normalized = call.clone();
    normalized.name = name.into();
    normalized.arguments = args.as_object()?.clone();
    Some(normalized)
}

#[cfg(test)]
pub(super) mod tests;

fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).unwrap_or(&Value::Null)
}
