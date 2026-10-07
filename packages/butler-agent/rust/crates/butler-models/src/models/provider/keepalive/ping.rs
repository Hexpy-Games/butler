use super::Snapshot;
use crate::models::{PromptUsageAttribution, PromptUsageMetricInput, transport};
use butler_turn::btcc::ModelRoundError;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

const TRAILING: &str = "Cache keepalive. Reply with one word: OK. Do not call tools.";

pub(super) async fn send(
    snapshot: &Snapshot,
    stop: CancellationToken,
    last_real: tokio::time::Instant,
) -> Result<(), ModelRoundError> {
    let (body, prefix, mut diagnostic) = prepare(snapshot)?;
    diagnostic["idleGapMs"] = (last_real.elapsed().as_secs_f64() * 1000.0).into();
    let encoded = prefix
        .body_json(&body)
        .map_err(|_| ModelRoundError::StablePrefix("keepalive_serialization_failed".into()))?;
    let (_, mode, api) = crate::models::provider::route::carrier(&snapshot.config);
    let http = snapshot
        .http
        .try_clone()
        .ok_or_else(|| ModelRoundError::StablePrefix("keepalive_request_not_replayable".into()))?;
    let http = http.body(encoded.clone());
    drop(body);
    let trace = crate::models::provider::request_trace::RequestTrace::ephemeral(
        prefix,
        snapshot.metrics.clone(),
    );
    let response = transport::execute(transport::RequestExecution {
        request: http,
        provider: "openai",
        api,
        policy: snapshot.config.policy,
        external: stop.clone(),
        mode,
        stream_observer: None,
        attempts: 1.0,
        admission: None,
        physical_admission: None,
        serialized_bytes: encoded.len(),
        guard_start: transport::GuardStart::AfterAdmission,
        request_observer: &|| {},
        trace: &trace,
        clock: snapshot.clock.as_ref(),
        quota: None,
    })
    .await;
    let response = response?;
    if !stop.is_cancelled() {
        crate::models::provider::prefix_diagnostics::reported_usage(&mut diagnostic, &response);
        diagnostic["status"] = "completed".into();
        record(snapshot, diagnostic, Some(&response)).await?;
    }
    Ok(())
}

fn prepare(
    snapshot: &Snapshot,
) -> Result<
    (
        Value,
        crate::models::provider::prefix_diagnostics::Prepared,
        Value,
    ),
    ModelRoundError,
> {
    let mut body = snapshot.body.clone();
    let items = body["input"]
        .as_array_mut()
        .ok_or_else(|| ModelRoundError::StablePrefix("keepalive_input_not_array".into()))?;
    items.push(json!({"role":"user","content":[{"type":"input_text","text":TRAILING}]}));
    // Preserve the physical prefix, including any output limit before input.
    // Codex rejects output caps; API limits after input can safely be lowered.
    let object = body
        .as_object_mut()
        .ok_or_else(|| ModelRoundError::StablePrefix("keepalive_body_invalid".into()))?;
    let store_before_input = object
        .keys()
        .take_while(|key| key.as_str() != "input")
        .any(|key| key == "store");
    if snapshot.config.auth.mode() == crate::models::ProviderAuthMode::ApiKey && !store_before_input
    {
        object.insert("store".into(), false.into());
    }
    let cap_before_input = object
        .keys()
        .take_while(|key| key.as_str() != "input")
        .any(|key| key == "max_output_tokens");
    if snapshot.config.auth.mode() == crate::models::ProviderAuthMode::ApiKey
        && !cap_before_input
        && !object
            .get("max_output_tokens")
            .and_then(Value::as_f64)
            .is_some_and(|max| max < 16.0)
    {
        object.insert("max_output_tokens".into(), json!(16));
    }
    let history = crate::models::provider::prefix_diagnostics::History::default();
    let prefix = history.prepare(&body, &snapshot.config)?;
    let mut diagnostic = snapshot.prefix.extension_diagnostic(&prefix)?;
    diagnostic["turnId"] = snapshot.turn.clone().into();
    diagnostic["phase"] = "keepalive".into();
    Ok((body, prefix, diagnostic))
}

async fn record(
    snapshot: &Snapshot,
    diagnostic: Value,
    response: Option<&Value>,
) -> Result<(), ModelRoundError> {
    let metrics = snapshot.metrics.clone();
    let model = snapshot.config.metadata.model_ref.clone();
    let scope = format!(
        "btcc-keepalive:{}",
        snapshot
            .scope
            .strip_prefix("btcc-guided:")
            .unwrap_or(&snapshot.scope)
    );
    let data = snapshot.data.clone();
    let usage = response.and_then(|r| super::super::result::openai_usage(r, &model, 0));
    let number = |key| {
        usage
            .as_ref()
            .and_then(|r| r.get(key))
            .and_then(Value::as_f64)
    };
    let input = number("promptTokens");
    let total = number("totalTokens");
    let cached = number("cachedTokens").unwrap_or(0.0);
    let reasoning = response.and_then(super::super::result::reasoning_tokens);
    let cache_write = response.and_then(super::super::result::cache_write_tokens);
    let auth = snapshot
        .catalog
        .usage_auth_mode("openai", snapshot.config.auth.mode());
    tokio::task::spawn_blocking(move || {
        let attribution = PromptUsageAttribution {
            turn_id: None,
            phase: Some("keepalive"),
            round_index: None,
            reasoning_effort: None,
            requested_output_tokens: None,
            budget_state: None,
            budget_state_source: None,
            prompt_sections: None,
        };
        metrics.append(PromptUsageMetricInput {
            model: &model,
            scope: &scope,
            prompt_tokens: input,
            cached_tokens: cached,
            total_tokens: total,
            cache_write_tokens: cache_write.map(Some),
            prompt_cache_key: None,
            prompt_cache_retention: None,
            butler_data: data.as_deref(),
            usage_attribution: Some(&attribution),
            reasoning_tokens: reasoning,
            cache_write_1h_tokens: None,
            auth_mode: Some(auth),
            prefix_diagnostics: Some(&diagnostic),
        })
    })
    .await
    .map_err(|_| ModelRoundError::StablePrefix("keepalive_metric_worker_failed".into()))?
}
