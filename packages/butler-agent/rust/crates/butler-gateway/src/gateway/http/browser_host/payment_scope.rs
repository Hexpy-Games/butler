//! Standing purchase use produces a public event after the browser answers.
use super::{HttpError, HttpState};
use serde_json::{Value, json};
use std::sync::Arc;

pub(super) async fn finish(
    state: &Arc<HttpState>,
    op: &str,
    sent: &Value,
    session: &str,
    result: &Value,
) -> Result<(), HttpError> {
    if !matches!(op, "pay.fill" | "tab.act")
        || !sent["args"]["payment_skip"].is_object()
        || !matches!(
            result["status"].as_str(),
            Some("ok" | "filled" | "user_required")
        )
    {
        return Ok(());
    }
    let Some(site) = sent["args"]["payment_skip"]["site"].as_str() else {
        return Ok(());
    };
    let payload = json!({"session_id":session,"turn_id":sent["turn_id"],"site":site,
        "amount":sent["args"]["payment_skip"]["amount"],"operation":op});
    if let Some(payload) = payload.as_object() {
        state
            .application
            .publish_gateway_event("browser.payment_confirmation_skipped", payload.clone())
            .await?;
    }
    Ok(())
}

/// Re-read the standing allow immediately before dispatch and freeze its site
/// for the event, even if the payment closes or navigates the tab afterward.
pub(super) async fn prepare(
    state: &Arc<HttpState>,
    frame: &mut Value,
    tab: &Value,
) -> Result<Option<Value>, HttpError> {
    if frame["schedule_browser"]["payment"] == false
        && (frame["op"] == "pay.fill" || frame["args"]["payment_skip"].is_object())
    {
        return Ok(Some(
            json!({"status":"not_dispatched","reason":"schedule_payment_off"}),
        ));
    }
    if !frame["args"]["payment_skip"].is_object() {
        return Ok(None);
    }
    if !super::pay::purchase_allowed(state, tab).await? {
        return Ok(Some(
            json!({"status":"not_dispatched","reason":"payment_approval_required"}),
        ));
    }
    frame["args"]["payment_skip"]["site"] = json!(super::pay::merchant_site(state, tab));
    Ok(None)
}
