//! Close-ups are for looking: only the newest per tab keeps its pixels, and none
//! outlives a newer observation of that tab.
use super::super::contracts::{ModelRoundMessage, ModelRoundRole};
use super::field;
use serde_json::{Value, json};
use std::collections::HashMap;

const ZOOM: &str = "butler.browser-zoom.v1";

pub(super) fn supersede(messages: &mut [ModelRoundMessage]) {
    let mut newest: HashMap<String, usize> = HashMap::new();
    let mut zooms = Vec::new();
    for (index, message) in messages.iter().enumerate() {
        if message.role != ModelRoundRole::Tool || !message.content.contains("butler.browser-") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&message.content) else {
            continue;
        };
        let output = field(&value, "output");
        let schema = field(output, "schema").as_str().unwrap_or("");
        let Some(tab) = field(output, "tab").as_str() else {
            continue;
        };
        if schema == ZOOM && field(output, "status") != "superseded" {
            zooms.push((index, tab.to_owned()));
        }
        if matches!(schema, ZOOM | "butler.browser-observation.v1") {
            newest.insert(tab.to_owned(), index);
        }
    }
    for (index, tab) in zooms {
        if newest.get(&tab) != Some(&index)
            && let Some(message) = messages.get_mut(index)
        {
            message.content = json!({"ok":true,"output":{"schema":ZOOM,"tab":tab,"status":"superseded",
                "recovery":"An older close-up. Zoom again on the newest observation if you need to look closer."}})
            .to_string()
            .into();
        }
    }
}
