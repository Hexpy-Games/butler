//! `browser_open {results}`: this turn's `web_search` results by id, each in
//! its own background tab, all opened in parallel. Search results are pages
//! Butler found for this turn, so they open like a URL the user supplied.
use super::super::GuidedTools;
use super::{client::Client, encode_page_data, grant};
use butler_core::json::JsonDocument;
use butler_turn::btcc::{GuidedInvocation, ModelRoundToolCall, ToolExecutionError};
use serde_json::{Value, json};

const UNKNOWN_RESULT: &str = "No web_search result of this turn has that id. Use an id from this turn's web_search results, or pass its url.";
const READ_NEXT: &str =
    "Read the open pages with browser_observe; independent tabs can be observed in one round.";

pub(super) async fn execute(
    owner: &GuidedTools,
    invocation: &GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    occurrence: &str,
    client: Client,
) -> Result<JsonDocument, ToolExecutionError> {
    let args = Value::Object(call.arguments.clone());
    let ids = args["results"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .collect::<Vec<_>>();
    let open = |args: Value| open_one(owner, invocation, call, occurrence, &client, args);
    let open = &open;
    let opens = ids.iter().copied().map(|id| async move {
        let Some(found) = owner.web_session.search_result(id) else {
            return Ok(
                json!({"result":id,"status":"not_dispatched","reason":"unknown_result",
                "recovery":UNKNOWN_RESULT}),
            );
        };
        let mut result = open(json!({"url":found.url,"background":true})).await?;
        result["result"] = json!(id);
        Ok::<_, ToolExecutionError>(result)
    });
    let tabs = futures_util::future::try_join_all(opens).await?;
    let opened = tabs.iter().filter(|tab| tab["status"] == "ok").count();
    let status = match opened {
        0 => "not_dispatched",
        n if n == tabs.len() => "ok",
        _ => "partial",
    };
    let mut result = json!({"status":status,"tabs":tabs});
    if opened > 0 {
        result["next"] = json!(READ_NEXT);
    }
    encode_page_data(result)
}

async fn open_one(
    owner: &GuidedTools,
    invocation: &GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    occurrence: &str,
    client: &Client,
    args: Value,
) -> Result<Value, ToolExecutionError> {
    let request = ("tab.open", &Value::Null, &args);
    let result = grant::call(
        owner,
        call,
        occurrence,
        client,
        request,
        invocation.cancellation,
    )
    .await?;
    remember(owner, &args, &result);
    Ok(result)
}

/// An opened page is remembered so `web_read` reads its tab.
pub(super) fn remember(owner: &GuidedTools, args: &Value, result: &Value) {
    if result["status"] == "ok"
        && let (Some(url), Some(tab)) = (args["url"].as_str(), result["tab"].as_str())
    {
        let landed = result["url"].as_str().unwrap_or(url);
        owner.web_session.remember_tab(url, tab, landed);
        // The page was requested already; reading it again sends nothing new.
        owner.web_session.discover(url);
        owner.web_session.discover(landed);
    }
}
