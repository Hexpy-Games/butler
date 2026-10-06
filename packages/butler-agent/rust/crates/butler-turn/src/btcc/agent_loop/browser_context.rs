//! Provider history only: journaled observations and receipts remain immutable.
use super::contracts::{ModelRoundMessage, ModelRoundRole};
use serde_json::{Value, json};
use std::collections::HashMap;
fn observation(message: &ModelRoundMessage) -> Option<(String, String)> {
    if message.role != ModelRoundRole::Tool {
        return None;
    }
    let value: Value = serde_json::from_str(&message.content).ok()?;
    let output = value.get("output")?;
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
    for (index, message) in messages.iter().enumerate().rev() {
        if let Some((tab, obs)) = observation(message)
            && latest.insert(tab, index).is_some()
        {
            old.push((index, obs));
        }
    }
    // Fold in groups of eight during long browser runs, preserving the cache prefix.
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
