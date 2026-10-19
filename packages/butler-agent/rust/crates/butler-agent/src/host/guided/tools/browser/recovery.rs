//! Conversation-scoped recovery for a refused tab id.
use super::client::Client;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

pub(super) async fn attach(
    client: &Client,
    tab: &Value,
    result: &mut Value,
    signal: &CancellationToken,
) {
    let listed = Box::pin(client.call("tabs.list", &Value::Null, &json!({}), signal)).await;
    let Some(tabs) = listed.get("tabs").and_then(Value::as_array) else {
        return;
    };
    result["tabs"] = Value::Array(tabs.iter().map(|tab| {
        let mut tab = json!({"tab":tab.get("tab").or_else(||tab.get("id")), "url":tab["url"], "title":tab["title"]});
        super::delimit_labels(&mut tab);
        tab
    }).collect());
    let given = tab.as_str().unwrap_or("");
    result["recovery"] = if tabs.is_empty() {
        json!(
            "This conversation has no open tabs. Open the page with browser_open first, then use the tab id it returns."
        )
    } else {
        json!(format!(
            "No tab of this conversation has id {given}. Use a tab id listed in tabs, or open the page with browser_open first."
        ))
    };
}
