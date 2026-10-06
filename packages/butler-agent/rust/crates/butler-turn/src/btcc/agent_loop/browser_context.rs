//! Provider history only: journaled observations and receipts remain immutable.
use super::contracts::{ModelRoundMessage, ModelRoundRole};
use serde_json::{Value, json};
use std::collections::HashMap;
fn observation(message: &mut ModelRoundMessage) -> Option<(String, String)> {
    if message.role != ModelRoundRole::Tool {
        return None;
    }
    let mut value: Value = serde_json::from_str(&message.content).ok()?;
    let output = value.get_mut("output")?;
    if output["schema"] == "butler.browser-action.v1" {
        if strip_desktop_stills(output) {
            message.content = value.to_string().into();
        }
        message.image_attachments.clear();
        return None;
    }
    if output["schema"] != "butler.browser-observation.v1" {
        return None;
    }
    Some((
        output["tab"].as_str()?.into(),
        output["obs"].as_str()?.into(),
    ))
}
pub(super) fn supersede(messages: &mut [ModelRoundMessage]) {
    let mut latest = HashMap::new();
    let mut old = Vec::new();
    for (index, message) in messages.iter_mut().enumerate().rev() {
        if let Some((tab, obs)) = observation(message)
            && latest.insert(tab, index).is_some()
        {
            old.push((index, obs));
        }
    }
    // Bound each history rewrite batch to eight observations.
    // The final small tail is folded as well so only the newest observation is full.
    for batch in old.chunks(8) {
        for (index, obs) in batch {
            let Some(message) = messages.get_mut(*index) else {
                continue;
            };
            message.content=json!({"ok":true,"output":{"obs":obs,"status":"superseded","note":"Prior browser observation; receipts remain in the journal."}}).to_string().into();
            message.image_attachments.clear();
        }
    }
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
