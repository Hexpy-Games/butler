use super::{Error, support};
use butler_models::models::*;
use butler_turn::btcc::*;
use serde_json::Value;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use url::Url;

pub(super) fn provider(endpoint: Url) -> Result<ModelProvider, Error> {
    let catalog = Arc::new(ModelCatalog::new()?);
    let snapshot = Arc::new(catalog.snapshot(
        ModelCatalogSnapshotInput {
            configured_local: vec![],
            extra_models: vec![],
            registered_models: vec![],
            credential_views: vec![],
            default_model_ref: None,
            generated_at: "synthetic".into(),
        },
        &butler_core::locale::LocaleCollation::new("en-US")?,
    )?);
    Ok(ModelProvider::new(
        butler_log::http::external(butler_log::http::Purpose::new("model")).build()?,
        Arc::new(support::Config { endpoint, snapshot }),
        Arc::new(support::Observer),
        catalog,
        Arc::new(support::Clock),
        Arc::new(support::Metrics),
    ))
}

pub(super) async fn request(
    provider: &ModelProvider,
    model: &str,
    messages: &[ModelRoundMessage],
    continuation: Option<&Value>,
) -> Result<ModelRoundResult, ModelRoundError> {
    provider
        .run_round(ModelRoundRequest {
            max_output_tokens: None,
            round_id: None,
            model,
            messages,
            instructions: Some("Inspect the workspace."),
            tools: &[],
            tool_surface_digest: None,
            tool_choice: None,
            reasoning_effort: &butler_turn::btcc::ReasoningEffort::Medium,
            cancellation: CancellationToken::new(),
            attachments: &[],
            image_carrier: None,
            image_capability: None,
            image_manifests: &[],
            verified_image_payload: None,
            butler_data: None,
            usage_attribution: None,
            cache_scope: None,
            stable_provider_cache_prefix: None,
            route_context: None,
            provider_retry_attempts: Some(1.0),
            route_transport_attempt_ordinal: None,
            continuation,
            bounded_continuation: None,
            provider_body_admission: None,
            stream_observer: None,
            identity_observer: None,
        })
        .await
}

/// Deterministic synthetic outputs; no real filesystem tool or model credentials.
pub(super) fn outputs(messages: &mut Vec<ModelRoundMessage>, rounds: std::ops::Range<usize>) {
    for round in rounds {
        let mut message = ModelRoundMessage::user(format!("synthetic-output-{round}"), None);
        message.role = ModelRoundRole::Tool;
        message.tool_call_id = Some(format!("acc-call-{round}"));
        message.name = Some("list_files".into());
        messages.push(message);
    }
}
pub(super) fn key(
    turn: &TurnRecord,
    claim: &StateExecutionClaim,
    model: &str,
    round: usize,
) -> ModelRoundKey {
    ModelRoundKey {
        turn_id: turn.turn_id.clone(),
        round_id: format!("round-{round}"),
        route_digest: "fixture-route".into(),
        candidate_index: 0,
        model_ref: model.into(),
        checkpoint_id: Some(claim.checkpoint_id.clone()),
        checkpoint_revision: Some(claim.checkpoint_revision),
    }
}

/// Seed the authority prerequisite, then use the real suspension/resume transactions.
pub(super) async fn resume(
    repo: &BtccRepositories,
    turn: &TurnRecord,
    claim: &StateExecutionClaim,
    path: &str,
) -> Result<(TurnRecord, StateExecutionClaim), Error> {
    let path = path.to_owned();
    let seed_path = path.clone();
    tokio::task::spawn_blocking(move || -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let db = butler_platform::sqlite::open(std::path::Path::new(&seed_path))?;
        db.execute_batch("INSERT INTO btcc_authority_requests
        (request_id,request_ref,identity_sha256,owner_session_id,source_session_id,source_turn_id,
        source_work_id,workspace_path,plan_revision_id,action_key,authority_generation,capability,
        normalized_target,normalized_input_json,model_ref,reasoning_effort,category,reason,executable,
        command_count,decision,allow_scope,schedule_client_message_id,schedule_input_text,outcome,created_at,updated_at)
        VALUES ('request','authority-ref','identity','session','session','turn','work','fixture','plan','action',1,
        'shell','target','{}','fixture','medium','command','reason','echo',1,'pending','once','client-message','input','pending','now','now');
        INSERT INTO btcc_guided_tool_calls(call_id,turn_id,tool_name,raw_arguments,arguments_json,status,started_at)
        VALUES ('call-1','turn','shell','{}','{}','started','now');")?;
        Ok(())
    }).await?.map_err(|e| e.to_string())?;
    repo.commit_transition(
        turn,
        claim,
        &TurnTransition::Suspend {
            reason: SuspensionReason::AuthorityPending,
            authority_continuation: Some(Box::new(AuthorityLoopContinuation::fixture(
                "authority-ref",
                "call-1",
            ))),
        },
    )
    .await?;
    repo.activate_successor(&turn.turn_id).await?;
    let path = path.clone();
    tokio::task::spawn_blocking(move || -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let db = butler_platform::sqlite::open(std::path::Path::new(&path))?;
        db.execute("UPDATE btcc_authority_requests SET decision='allowed' WHERE request_ref='authority-ref'", [])?;
        Ok(())
    }).await?.map_err(|e| e.to_string())?;
    let resumed = repo
        .resume_authority(&turn.turn_id)
        .await?
        .ok_or("missing resumed turn")?;
    let claim = repo.acquire_state_claim(&resumed).await?;
    Ok((resumed, claim))
}

pub(super) struct LivenessProbe;
impl ProcessLiveness for LivenessProbe {
    fn is_alive(&self, owner: &RuntimeOwnerIdentity) -> bool {
        let Ok(pid) = i32::try_from(owner.process_id) else {
            return true;
        };
        butler_platform::process_control::target_liveness(pid)
            != butler_platform::process_control::Liveness::Gone
    }
}

/// Grow synthetic rounds from one real provider result, using the public record path.
/// Keep provider JSON fields and insertion order; only identifiers/new items change.
pub(super) fn seed(previous: &ModelRoundResult, round: usize) -> Result<ModelRoundResult, Error> {
    let mut result = previous.clone();
    let continuation = result.continuation.as_mut().ok_or("missing continuation")?;
    let items = continuation
        .get_mut("statelessInput")
        .and_then(Value::as_array_mut)
        .ok_or("missing items")?;
    let mut call = items.last().ok_or("missing call")?.clone();
    call["id"] = format!("fc_acc-{round}").into();
    call["call_id"] = format!("acc-call-{round}").into();
    call["syntheticPadding"] = format!("round-{round}:{}", "synthetic data ".repeat(393)).into();
    items.push(serde_json::json!({"type":"function_call_output","call_id":format!("acc-call-{}",round-1),"output":format!("synthetic-output-{}", round-1)}));
    items.push(call);
    continuation["sent"]["toolMessages"] = round.into();
    if let Some(call) = result.tool_calls.first_mut() {
        call.id = format!("acc-call-{round}");
    }
    Ok(result)
}

/// INSERT OR IGNORE must discard the uncommitted carrier from the lane memo.
pub(super) async fn duplicate(
    repo: &BtccRepositories,
    mut write: ModelRoundAcceptanceWrite,
) -> Result<(), Error> {
    write
        .result
        .continuation
        .as_mut()
        .and_then(|v| v.get_mut("statelessInput"))
        .and_then(Value::as_array_mut)
        .ok_or("missing stateless seed")?
        .push(Value::Null);
    repo.record_model_round_acceptance(write).await?;
    Ok(())
}

/// Object equality ignores insertion order; this rewrite changes only serialized bytes.
pub(super) fn reorder_item(result: &mut ModelRoundResult) -> Result<(), Error> {
    let items = result
        .continuation
        .as_mut()
        .and_then(|v| v.get_mut("statelessInput"))
        .and_then(Value::as_array_mut)
        .ok_or("missing continuation items")?;
    let item = items.get_mut(1).ok_or("missing original call")?;
    let old = item
        .get("extension")
        .and_then(Value::as_object)
        .ok_or("missing extension")?;
    let mut reordered = serde_json::Map::new();
    for key in ["a", "z", "2"] {
        reordered.insert(
            key.into(),
            old.get(key).ok_or("missing fixture field")?.clone(),
        );
    }
    item["extension"] = Value::Object(reordered);
    Ok(())
}

/// A literal rewrite pins escaping, nested values and JavaScript number formatting.
pub(super) fn literal_item(result: &mut ModelRoundResult) -> Result<(), Error> {
    let items = result
        .continuation
        .as_mut()
        .and_then(|v| v.get_mut("statelessInput"))
        .and_then(Value::as_array_mut)
        .ok_or("missing continuation items")?;
    let call = items.last_mut().ok_or("missing call")?;
    call["extension"] = serde_json::json!({
        "quoted": "line\n\"\\한글😀",
        "values": [null, true, false, -0.0, 1.5, 1e-7, 1e21, {"z": "last", "a": "first", "2": "two"}],
    });
    Ok(())
}
