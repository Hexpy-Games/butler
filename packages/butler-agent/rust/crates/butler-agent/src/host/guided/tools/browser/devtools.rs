//! `browser_devtools {tab, read}`: console errors, a network summary or the DOM
//! of a tab. A read like `browser_observe`, behind the same site grants, and
//! masked one way on every tab.
use super::super::{GuidedTools, dispatch::encoded};
use super::{client, encode_page_data, grant};
use butler_core::json::JsonDocument;
use butler_runtime::browser::{DEVTOOLS_OP, devtools_selector_allowed};
use butler_turn::btcc::{GuidedInvocation, ModelRoundToolCall, ToolExecutionError};
use serde_json::{Value, json};

const READS: &[&str] = &["console", "network", "dom"];
const MAX_SELECTOR: usize = 200;

fn invalid(args: &Value) -> Option<&'static str> {
    if !args["read"]
        .as_str()
        .is_some_and(|read| READS.contains(&read))
    {
        return Some("invalid_read");
    }
    args["selector"]
        .as_str()
        .is_some_and(|selector| {
            selector.len() > MAX_SELECTOR || !devtools_selector_allowed(selector)
        })
        .then_some("invalid_selector")
}

pub(super) async fn execute(
    owner: &GuidedTools,
    invocation: &GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    occurrence: &str,
    client: client::Client,
    args: Value,
) -> Result<JsonDocument, ToolExecutionError> {
    if let Some(reason) = invalid(&args) {
        return encoded(&json!({"status":"not_dispatched","reason":reason}));
    }
    // Built here so a model argument reaches the host only as what it is.
    let read = json!({"read":args["read"],"selector":args["selector"],
        "only_failed":args["only_failed"],"offset":args["offset"]});
    let request = (DEVTOOLS_OP, &args["tab"], &read);
    let signal = invocation.cancellation;
    let result = grant::call(owner, call, occurrence, &client, request, signal).await?;
    encode_page_data(result)
}
