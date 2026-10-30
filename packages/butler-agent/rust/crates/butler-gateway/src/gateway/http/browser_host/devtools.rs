//! DevTools replies at the gateway: the host's report of the page at read time
//! decides where the tab stands, a read off what was allowed returns nothing,
//! and masking happens here before anything goes further.
use butler_runtime::browser::devtools::{self, PLACE_OP};
use serde_json::{Map, Value, json};

/// A DevTools op on a loopback page: the one reach those ops have that page
/// reads do not. The model cannot navigate there; the tab is already on it.
pub(super) fn local_read(op: &str, url: &str) -> bool {
    devtools::is_op(op) && devtools::local_url(url)
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

pub(super) fn finish(op: &str, args: &Value, result: &mut Value) {
    let events = result.get("events").cloned();
    *result = reply(op, args, result);
    if let Some(events) = events {
        result["events"] = events;
    }
}

fn reply(op: &str, args: &Value, report: &Value) -> Value {
    if report["status"] != "ok" {
        return refusal(report);
    }
    let standing = match devtools::standing(report) {
        Ok(standing) => standing,
        Err(reason) => return json!({"status":"not_dispatched","reason":reason}),
    };
    if op == PLACE_OP {
        return devtools::place_reply(report, &standing);
    }
    let expected = &args["expect"];
    if expected["place"] != standing.place.as_str() || expected["site"] != standing.site.as_str() {
        return json!({"status":"not_dispatched","reason":"devtools_page_changed",
            "place":standing.place.as_str(),"site":standing.site,
            "recovery":"The tab is no longer where this read was allowed. Call browser_devtools again; it asks about the tab's current page."});
    }
    devtools::read_reply(report, &standing)
}
