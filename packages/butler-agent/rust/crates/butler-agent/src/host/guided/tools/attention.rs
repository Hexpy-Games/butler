//! Exact skipped actions share the card projection, without admitting a card.
use super::GuidedTools;
use butler_turn::btcc::{
    AuthorityAdmissionInput, AuthorityAdmissionResult, ModelRoundToolCall, TurnTaint,
};
use serde_json::{Value, json};

pub(super) async fn admit(
    owner: &GuidedTools,
    input: AuthorityAdmissionInput,
) -> Result<AuthorityAdmissionResult, butler_turn::btcc::AuthorityError> {
    let facts = input.unattended.then(|| input.clone());
    let result = owner.authority.admit(input).await?;
    if matches!(result, AuthorityAdmissionResult::Unattended)
        && let Some(facts) = facts
    {
        skipped(owner, facts, "schedule_permission_required").await;
    }
    Ok(result)
}

pub(super) async fn skipped_call(owner: &GuidedTools, call: &ModelRoundToolCall) {
    let prepared = if super::direct_approval::supports(call) {
        Ok((call.name.clone(), Value::Object(call.arguments.clone())))
    } else {
        super::effect::attention_facts(owner, call).await
    };
    if let Ok((target, input)) = prepared {
        skipped_input(owner, call, input, &target, "schedule_permission_required").await;
    }
}

pub(super) async fn skipped_input(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    input: Value,
    target: &str,
    code: &str,
) {
    let occurrence = butler_turn::btcc::digest_identity(
        &json!({"capability":call.name,"target":target,"input":input}).to_string(),
    );
    let facts = AuthorityAdmissionInput {
        owner_session_id: owner.binding.owner_session_id.clone(),
        source_session_id: owner.binding.source_session_id.clone(),
        source_turn_id: owner.binding.turn_id.clone(),
        operation_occurrence_id: Some(occurrence),
        source_work_id: String::new(),
        workspace_path: owner.active_workspace_path().to_string_lossy().into_owned(),
        plan_revision_id: String::new(),
        action_key: call.name.clone(),
        authority_generation: 1,
        capability: call.name.clone(),
        target: target.into(),
        normalized_input: input,
        model_ref: owner.binding.model_ref.clone(),
        reasoning_effort: owner.binding.reasoning_effort.clone(),
        category: Some("reviewed_effect".into()),
        public_action_title: (owner.taint() != TurnTaint::Clean)
            .then(|| "authority.taintReason".into()),
        honor_standing_permission: false,
        unattended: true,
    };
    skipped(owner, facts, code).await;
}

async fn skipped(owner: &GuidedTools, facts: AuthorityAdmissionInput, code: &str) {
    let capability = facts.capability.clone();
    if let Ok(identity) = owner.authority.action_identity(&facts)
        && let Ok(approval) = owner.authority.preview_approval(facts)
    {
        notify(owner, &capability, approval, &identity, code).await;
    }
}

async fn notify(
    owner: &GuidedTools,
    capability: &str,
    mut approval: butler_turn::btcc::AuthorityApproval,
    action_identity: &str,
    code: &str,
) {
    // The notice names the action by its operation; the examples carry raw call arguments and are not stored.
    approval.examples.clear();
    approval.examples_truncated.clear();
    let Some(run) = owner
        .inherited_run()
        .filter(|r| !r.automation_id.is_empty() && !r.run_id.is_empty())
    else {
        return;
    };
    let identity = format!("{}:{action_identity}", run.run_id);
    let action = json!({"capability":capability,"approval":approval,"identity":action_identity});
    if !owner.attention_sent.lock().insert(identity.clone()) {
        return;
    }
    let Ok(client) = crate::host::automation::client::ScheduleClient::active(&owner.app_endpoint)
    else {
        owner.attention_sent.lock().remove(&identity);
        return;
    };
    let encode = |s: &str| url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>();
    let path = format!(
        "/automations/{}/runs/{}/attention",
        encode(&run.automation_id),
        encode(&run.run_id)
    );
    let mut action = action;
    if owner.binding.source_session_id != owner.binding.owner_session_id {
        action["work_session_id"] = json!(owner.binding.source_session_id);
    }
    let body = json!({"code":code,"tainted":code == "schedule_permission_required" && owner.taint()!=TurnTaint::Clean,"action":action});
    if client
        .request(reqwest::Method::POST, &path, Some(body))
        .await
        .is_err()
    {
        owner.attention_sent.lock().remove(&identity);
    }
}
