//! Review the complete set of destination URLs before opening any tab.
use super::*;

pub(super) async fn execute(
    owner: &GuidedTools,
    invocation: &GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    occurrence: &str,
    client: client::Client,
    args: Value,
) -> Result<JsonDocument, ToolExecutionError> {
    let urls = destinations(owner, &args);
    let target = urls.join("\n");
    let steps: Vec<_> = urls
        .iter()
        .map(|url| json!({"action":"navigate","value_preview":url}))
        .collect();
    let input = json!({"navigation":true,"urls":urls,"arguments":args,"resolved_steps":steps});
    if client.approval_handoff {
        return encoded(&handoff(&args, "approval_required"));
    }
    let reference = match authority::act_gate(owner, call, occurrence, &input, &target).await? {
        authority::Gate::Pending(value) => return encoded(&value),
        authority::Gate::Allowed(reference, _) => reference,
    };
    let result = if args.get("results").is_some() {
        open::execute(owner, invocation, call, occurrence, client).await
    } else {
        let request = ("tab.open", &Value::Null, &args);
        let result = grant::call(
            owner,
            call,
            occurrence,
            &client,
            request,
            invocation.cancellation,
        )
        .await?;
        open::remember(owner, &args, &result);
        encode_page_data(result)
    };
    let status = match &result {
        Ok(value) if value.field("status").ok().flatten() == Some("ok") => "ok",
        Ok(_) => "failed",
        Err(_) => "unknown",
    };
    settle(owner, reference, status).await?;
    result
}

fn destinations(owner: &GuidedTools, args: &Value) -> Vec<String> {
    if let Some(url) = args["url"].as_str() {
        return vec![url.into()];
    }
    args["results"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter_map(|id| owner.web_session.search_result(id))
        .map(|found| found.url)
        .collect()
}
