//! Provider history only: journaled observations and receipts remain immutable.
use super::contracts::{ModelRoundMessage, ModelRoundRole, ModelRoundToolCall};
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Arc};
mod prune;
use prune::Stale;
pub(super) use prune::{BrowserPrune, prune};
mod summary;
mod zoom;

// Stale browser results stay byte-identical until their estimated size passes
// the budget; one prune then stubs every stale result since the previous prune.
// Gemini and Anthropic reuse a cache entry only where an earlier request ended,
// so rewriting one stale result per round would miss the cache every round.

struct Cycle {
    obs_index: usize,
    obs_id: String,
    act_indices: Vec<usize>,
    acted: Vec<String>,
}

struct History {
    tabs: HashMap<String, Vec<Cycle>>,
    latest_acts: HashMap<String, usize>,
    acts: Vec<(usize, String, ModelRoundToolCall, Value)>,
}

fn history(messages: &[ModelRoundMessage]) -> History {
    let mut calls = HashMap::new();
    let mut tabs: HashMap<String, Vec<Cycle>> = HashMap::new();
    let mut latest_acts = HashMap::new();
    let mut acts = Vec::new();
    for (index, message) in messages.iter().enumerate() {
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
        let Ok(value) = serde_json::from_str::<Value>(&message.content) else {
            continue;
        };
        let Some(output) = value.get("output") else {
            continue;
        };
        let observation = field(output, "schema") == "butler.browser-observation.v1";
        let action = field(output, "schema") == "butler.browser-action.v1";
        if !observation && !action {
            continue;
        }
        let Some(tab) = field(output, "tab")
            .as_str()
            .or_else(|| call?.arguments.get("tab")?.as_str())
            .map(str::to_owned)
        else {
            continue;
        };
        if observation {
            let call = call.filter(|call| call.name == "browser_act");
            open_cycle(&mut tabs, &value, (index, tab), call);
        } else if let Some(call) = call {
            attach_act(&mut tabs, &tab, index, call, field(&value, "output"));
            latest_acts.insert(tab.clone(), index);
            acts.push((index, tab, call.clone(), value));
        }
    }
    History {
        tabs,
        latest_acts,
        acts,
    }
}

/// A fresh observation opens a cycle. With `browser_act {observe:true}` its batch
/// also acted on the source cycle.
fn open_cycle(
    tabs: &mut HashMap<String, Vec<Cycle>>,
    value: &Value,
    (index, tab): (usize, String),
    act: Option<&ModelRoundToolCall>,
) {
    if let Some(call) = act
        && let Some(output) = value.get("output")
        && output.get("action").is_some()
    {
        attach_act(
            tabs,
            &tab,
            index,
            call,
            field(field(value, "output"), "action"),
        );
    }
    if let Some(obs_id) = field(field(value, "output"), "obs").as_str() {
        tabs.entry(tab).or_default().push(Cycle {
            obs_index: index,
            obs_id: obs_id.into(),
            act_indices: Vec::new(),
            acted: Vec::new(),
        });
    }
}

fn plan(messages: &[ModelRoundMessage]) -> Vec<Stale> {
    let History {
        tabs,
        latest_acts,
        acts,
    } = history(messages);
    let mut stale = Vec::new();
    for (tab, cycles) in &tabs {
        for (cycle, next) in cycles.iter().zip(cycles.iter().skip(1)).rev() {
            let Some(message) = messages.get(cycle.obs_index) else {
                continue;
            };
            if !is_superseded(&message.content) {
                stale.push(Stale::new(
                    cycle.obs_index,
                    message,
                    replace_observation(cycle, tab, &next.obs_id),
                ));
            }
        }
    }
    for (index, tab, call, value) in acts {
        let Some(message) = messages.get(index) else {
            continue;
        };
        if latest_acts.get(&tab) == Some(&index) || is_superseded(&message.content) {
            continue;
        }
        let output = field(&value, "output");
        let stub = json!({"ok":field(&value, "ok"),"output":{"schema":"butler.browser-action.v1","obs":call.arguments.get("observation"),"status":field(output, "status"),"steps":summary::steps(output),"superseded":true}}).to_string().into();
        stale.push(Stale::new(index, message, stub));
    }
    stale.extend(zoom::plan(messages));
    stale
}

/// `superseded_by` names the observation that replaced this one (the next
/// cycle of the tab), so the stub is final when written.
fn replace_observation(cycle: &Cycle, tab: &str, next: &str) -> Arc<str> {
    json!({"ok":true,"output":{"schema":"butler.browser-observation.v1",
        "obs":cycle.obs_id,"status":"superseded","acted":cycle.acted.join("; "),
        "tab":tab,"superseded_by":next,
        "recovery":"This is replaced history, not a tool failure or lost observation. Use the newest observation of this tab. Call browser_observe again if fresh state is needed; continue the unfinished page interaction."}})
    .to_string()
    .into()
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
    if let Some(action) = output.get_mut("action") {
        changed |= strip_desktop_stills(action);
    }
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
