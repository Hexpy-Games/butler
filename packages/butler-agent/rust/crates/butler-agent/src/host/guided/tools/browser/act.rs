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
    if client.approval_handoff {
        if upload::requested(&args) {
            return encoded(&handoff(&args, "upload"));
        }
        return run(owner, invocation, call, occurrence, client, args).await;
    }
    let staged = match upload::resolve(owner, occurrence, &mut args).await {
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
    if client.approval_handoff && prepared["status"] != "ok" {
        return executor_refusal(&args, prepared);
    }
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
    let input = approval_input(&args, &mut prepared, &scope, !client.approval_handoff);
    if let Some(refused) = schedule_payment_refusal(owner, call, &prepared, &input).await {
        return finish_batch(&args, refused);
    }
    if client.approval_handoff
        && (input["commit"] == true
            || input["always_confirm"] == true
            || authority::reviews(&owner.binding.access_mode, &input))
    {
        return encoded(&handoff(&args, "approval_required"));
    }
    let (approval, allow_scope) =
        match authority::act_gate(owner, call, occurrence, &input, &scope).await? {
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
            authority::Gate::Allowed(reference, scope) => (reference, scope),
        };
    apply(
        owner,
        invocation,
        call,
        occurrence,
        client,
        &args,
        PreparedAction {
            prepared,
            input,
            scope,
            approval,
            allow_scope,
        },
    )
    .await
}

struct PreparedAction {
    prepared: Value,
    input: Value,
    scope: String,
    approval: Option<String>,
    allow_scope: Option<String>,
}

async fn apply(
    owner: &GuidedTools,
    invocation: &GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    occurrence: &str,
    client: client::Client,
    args: &Value,
    batch: PreparedAction,
) -> Result<JsonDocument, ToolExecutionError> {
    let PreparedAction {
        prepared,
        input,
        scope,
        approval,
        allow_scope,
    } = batch;
    if allow_scope.as_deref() == Some("site") {
        let recorded = pay::allow_site(
            &client,
            &args["tab"],
            &input["merchant_site"],
            invocation.cancellation,
        )
        .await;
        if recorded["status"] != "ok" {
            settle(owner, approval, "failed").await?;
            return finish_batch(args, recorded);
        }
    }
    client
        .waiting(&args["tab"], false, invocation.cancellation)
        .await;
    let result = dispatch_effect(
        owner,
        invocation,
        occurrence,
        client.clone(),
        ApprovedBatch {
            args,
            prepared: &prepared,
            input,
            scope: &scope,
        },
    )
    .await?;
    if client.approval_handoff && result["status"] == "dialog_pending" {
        return encoded(&handoff(args, "dialog_pending"));
    }
    if result["status"] == "dialog_pending" {
        settle(owner, approval, "unknown").await?;
        return dialog::finish(owner, invocation, call, occurrence, client, args, &result).await;
    }
    settle(
        owner,
        approval,
        result["status"].as_str().unwrap_or("unknown"),
    )
    .await?;
    observe_after::finish(owner, invocation, &client, args, result).await
}

fn executor_refusal(args: &Value, prepared: Value) -> Result<JsonDocument, ToolExecutionError> {
    let needs_user = prepared["status"] == "needs_approval"
        || prepared["status"] == "dialog_pending"
        || matches!(
            prepared["reason"].as_str(),
            Some("secure_field" | "user_required")
        );
    if needs_user {
        encoded(&handoff(args, "approval_required"))
    } else {
        finish_batch(args, prepared)
    }
}

async fn schedule_payment_refusal(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    prepared: &Value,
    input: &Value,
) -> Option<Value> {
    let run = owner.schedule_run()?;
    if !prepared["steps"]
        .as_array()
        .is_some_and(|steps| steps.iter().any(authority::payment_step))
    {
        return None;
    }
    if !run.browser?.payment {
        return super::super::turn_guard::schedule_browser_feedback(
            owner,
            call,
            input,
            &act_scope(prepared),
            "schedule_payment_off",
        )
        .await;
    }
    if prepared["purchase_allowed"] != true {
        super::super::attention::skipped_input(
            owner,
            call,
            input.clone(),
            &act_scope(prepared),
            "schedule_permission_required",
        )
        .await;
        return Some(super::super::turn_guard::unattended_feedback(
            owner,
            &call.name,
            &act_scope(prepared),
        ));
    }
    None
}
