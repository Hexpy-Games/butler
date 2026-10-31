//! DevTools replies at the gateway: the page must be one the conversation may
//! read, and masking happens here before anything goes further.
use super::HttpState;
use butler_runtime::browser::{DEVTOOLS_OP, devtools_reply, local_url};
use serde_json::{Map, Value};

/// A read on a loopback page: the one reach this op has that page reads do not.
/// The model cannot navigate there; the tab is already on it.
pub(super) fn local_read(op: &str, url: &str) -> bool {
    op == DEVTOOLS_OP && local_url(url)
}

/// What a refusal may carry: never anything the host read from the page.
fn refusal(result: &Value) -> Value {
    let mut kept = Map::new();
    for key in ["status", "reason", "recovery", "tab", "your_tabs", "dialog"] {
        if !result[key].is_null() {
            kept.insert(key.into(), result[key].clone());
        }
    }
    Value::Object(kept)
}

pub(super) fn finish(state: &HttpState, session: &str, result: &mut Value) {
    let events = result.get("events").cloned();
    if !result["url"].as_str().is_some_and(local_url) {
        super::agent_calls::enforce_result_policy(state, session, DEVTOOLS_OP, result);
    }
    *result = if result["status"] == "ok" {
        devtools_reply(result)
    } else {
        refusal(result)
    };
    if let Some(events) = events {
        result["events"] = events;
    }
}
