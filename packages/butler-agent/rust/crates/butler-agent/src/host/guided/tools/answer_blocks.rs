//! Atomic structured-answer acceptance; invalid specs stay model-private.
use super::{GuidedTools, dispatch::encoded};
use butler_runtime::capabilities::answer_blocks::{self, AnswerBlocksContext};
use butler_turn::btcc::{ModelRoundToolCall, ToolExecutionError};
use serde_json::{Value, json};

pub(super) async fn execute(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    call_id: &str,
    progress: &dyn butler_turn::btcc::AgentLoopProgress,
) -> Result<butler_core::json::JsonDocument, ToolExecutionError> {
    let result = execute_spec(owner, call, call_id).await;
    if let Ok(value) = &result {
        let outcome = if value.field("ok").ok().flatten() == Some("true") {
            "accepted"
        } else {
            "rejected"
        };
        progress
            .answer_blocks_draft(
                String::new(),
                0,
                vec![json!({"op":"end", "outcome":outcome})],
            )
            .await
            .map_err(ToolExecutionError::Integrity)?;
    }
    result
}

async fn execute_spec(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    call_id: &str,
) -> Result<butler_core::json::JsonDocument, ToolExecutionError> {
    let mut spec = Value::Object(call.arguments.clone());
    answer_blocks::normalize(&mut spec);
    let candidates = answer_blocks::sources(&spec);
    let sources = owner
        .journal
        .read_sources(owner.binding.source_session_id.clone(), candidates)
        .await
        .map_err(|e| ToolExecutionError::Integrity(e.into()))?;
    let image_ids = spec["blocks"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|block| block["items"].as_array().into_iter().flatten())
        .filter_map(|item| item["img"].as_str().map(str::to_owned))
        .collect();
    let images = super::browser::lookup_assets(owner, image_ids).await;
    let context = AnswerBlocksContext {
        now: chrono::Utc::now(),
        // Asset acceptance is owned by image_collect's store (T4).
        image_exists: &|id| images.contains(id),
        read_sources: &sources,
    };
    if let Err(problems) = answer_blocks::validate_answer_blocks(&spec, &context) {
        return encoded(
            &json!({"ok":false,"error":{"code":"invalid_blocks","message":"Correct the listed fields and resend the complete spec.","problems":problems}}),
        );
    }
    let shown = answer_blocks::shown(&spec);
    answer_blocks::accept(&mut owner.state.lock().answer_blocks, call_id, spec);
    encoded(&json!({"ok":true,"shown":shown}))
}

pub(super) async fn remember_source(
    owner: &GuidedTools,
    call_id: &str,
    source: &str,
) -> Result<(), ToolExecutionError> {
    if let Some(source) = answer_blocks::source_identity(source) {
        owner
            .journal
            .remember_read_source(
                owner.binding.turn_id.clone(),
                call_id.to_owned(),
                owner.binding.source_session_id.clone(),
                source,
            )
            .await
            .map_err(|e| ToolExecutionError::Integrity(e.into()))?;
    }
    Ok(())
}

pub(super) async fn remember_browser_source(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    call_id: &str,
    result: &Value,
) -> Result<(), ToolExecutionError> {
    if matches!(call.name.as_str(), "browser_open" | "browser_observe")
        && result["status"] == "ok"
        && let Some(source) = result["url"].as_str()
    {
        remember_source(owner, call_id, source).await?;
    }
    Ok(())
}
