use super::*;

pub(super) async fn execute(
    owner: &GuidedTools,
    invocation: &GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    occurrence: &str,
    client: client::Client,
    mut args: Value,
) -> Result<JsonDocument, ToolExecutionError> {
    if let Some(refused) = act_refusal(owner, invocation, &client, &mut args).await {
        return finish_batch(&args, refused);
    }
    let staged = match upload::resolve(owner, &mut args).await {
        Ok(staged) => staged,
        Err(refused) => return finish_batch(&args, refused),
    };
    let result = run(owner, invocation, call, occurrence, client, args).await;
    let _ = tokio::task::spawn_blocking(move || staged.cleanup()).await;
    result
}

async fn run(
    owner: &GuidedTools,
    invocation: &GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    occurrence: &str,
    client: client::Client,
    args: Value,
) -> Result<JsonDocument, ToolExecutionError> {
    let request = ("tab.prepare", &args["tab"], &args);
    let mut prepared = grant::call(
        owner,
        call,
        occurrence,
        &client,
        request,
        invocation.cancellation,
    )
    .await?;
    if prepared["authority_pending"] == true {
        return finish_batch(&args, prepared);
    }
    if prepared["status"] == "dialog_pending" {
        return dialog::finish(
            owner, invocation, call, occurrence, client, &args, &prepared,
        )
        .await;
    }
    if prepared["status"] != "ok" {
        authority::refuse_resume(owner, call, occurrence).await?;
        client
            .waiting(&args["tab"], false, invocation.cancellation)
            .await;
        return finish_batch(&args, prepared);
    }
    let scope = act_scope(&prepared);
    let input = approval_input(&args, &mut prepared, &scope);
    let approval = match authority::act_gate(owner, call, occurrence, &input, &scope).await? {
        authority::Gate::Pending(value) => {
            client
                .waiting(
                    &args["tab"],
                    value["authority_pending"] == true,
                    invocation.cancellation,
                )
                .await;
            return finish_batch(&args, value);
        }
        authority::Gate::Allowed(reference) => reference,
    };
    client
        .waiting(&args["tab"], false, invocation.cancellation)
        .await;
    let result = dispatch_effect(
        owner,
        invocation,
        occurrence,
        client.clone(),
        ApprovedBatch {
            args: &args,
            prepared: &prepared,
            input,
            scope: &scope,
        },
    )
    .await?;
    if result["status"] == "dialog_pending" {
        settle(owner, approval, "unknown").await?;
        return dialog::finish(owner, invocation, call, occurrence, client, &args, &result).await;
    }
    settle(
        owner,
        approval,
        result["status"].as_str().unwrap_or("unknown"),
    )
    .await?;
    observe_after::finish(owner, invocation, &client, &args, result).await
}
