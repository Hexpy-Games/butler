//! Operator-driven canonical Conversation compaction and durable context evidence.

use std::{
    path::Path,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;

use crate::conversation::{
    AgentConversationStore, ConversationMessageWithParts, ConversationSummaryInput,
    ReadMessagesInput,
};

use super::{
    ContextBudgetOverrides, ContextBudgetOwner, ContextError, ContextResult,
    WorkingContextBudgetInput, canonical_conversation_session_id, trim_text_to_token_budget,
};

mod algorithm;
mod storage;

use algorithm::{build_summary, compaction_window, estimate_tokens, joined_message_text};
use storage::{CompactionLock, append_snapshot};

pub(crate) use storage::compaction_snapshot_path;

const READ_LIMIT: f64 = 5_000.0;
const PRESERVE_LAST_MESSAGES: usize = 8;

pub(crate) trait ContextCompactionMetricSink: Send + Sync {
    fn append_context_compaction_metric(&self, event: &CompactionMetricEvent) -> ContextResult<()>;
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompactionMetricEvent {
    pub schema: &'static str,
    pub ts: f64,
    pub session_id: String,
    pub snapshot_id: String,
    pub trigger: &'static str,
    pub status: &'static str,
    pub duration_ms: u64,
    pub model_ref: Option<String>,
    pub pre_estimated_tokens: f64,
    pub post_estimated_tokens: f64,
    pub reduction_ratio: f64,
    pub diagnostics: Vec<String>,
    pub raw_text_stored: bool,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct ContextCompactionSnapshot {
    pub schema: &'static str,
    pub snapshot_id: String,
    pub session_id: String,
    pub trigger: &'static str,
    pub status: &'static str,
    pub created_at: String,
    pub model_ref: Option<String>,
    pub model_context_window_tokens: f64,
    pub pre_estimated_tokens: f64,
    pub post_estimated_tokens: f64,
    pub summarized_event_range: EventRange,
    pub preserved_suffix_event_ids: Vec<String>,
    pub summarized_message_range: MessageRange,
    pub preserved_suffix_message_ids: Vec<String>,
    pub source_hash: Option<String>,
    pub summary: String,
    pub provenance: Vec<String>,
    pub diagnostics: Vec<String>,
    pub region_tokens: RegionTokens,
    pub known_gaps: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct EventRange {
    pub first_event_id: Option<String>,
    pub last_event_id: Option<String>,
    pub event_count: usize,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct MessageRange {
    pub first_message_id: Option<String>,
    pub last_message_id: Option<String>,
    pub from_seq: Option<u64>,
    pub to_seq: Option<u64>,
    pub message_count: usize,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct RegionTokens {
    pub working_context_tokens: f64,
    pub available_working_context_tokens: f64,
    pub used_working_ratio: f64,
    pub static_context_tokens: f64,
    pub live_configuration_tokens: f64,
    pub runtime_state_tokens: f64,
    pub compaction_prompt_reserve_tokens: f64,
}

pub(crate) async fn compact_transcript(
    butler_data: &Path,
    session_id: &str,
    store: &AgentConversationStore,
    budget_owner: &ContextBudgetOwner,
    metrics: &dyn ContextCompactionMetricSink,
) -> ContextResult<ContextCompactionSnapshot> {
    let canonical_session_id = canonical_conversation_session_id(store, session_id, None).await?;
    let _lock = CompactionLock::acquire(butler_data, &canonical_session_id).await?;
    let started = Instant::now();
    let budget = budget_owner.snapshot().await?;
    let messages = store
        .read_messages(ReadMessagesInput {
            session_id: canonical_session_id.clone(),
            limit: Some(READ_LIMIT),
            include_compacted: false,
        })
        .await
        .map_err(conversation_error)?;

    let window = compaction_window(&messages, PRESERVE_LAST_MESSAGES);
    let full_text = joined_message_text(&messages);
    let pre_tokens = estimate_tokens(&budget, &full_text)?;
    let resolved_budget = budget.resolve(None, &ContextBudgetOverrides::default());
    let chunk_budget = (resolved_budget.context_window_tokens * 0.20)
        .floor()
        .max(500.0);
    let summary_budget = (resolved_budget.context_window_tokens * 0.15)
        .floor()
        .clamp(200.0, 1_200.0);
    let mut diagnostics = Vec::new();
    let summary = build_summary(
        window.to_summarize,
        &budget,
        chunk_budget,
        summary_budget,
        &mut diagnostics,
    )?;
    let summary = summary.trim().to_owned();
    let status = if summary.is_empty() && !window.to_summarize.is_empty() {
        diagnostics.push("summary_empty".into());
        "failed"
    } else {
        "ok"
    };
    let preserved_tokens = estimate_tokens(&budget, &joined_message_text(window.preserved))?;
    let max_summary_tokens = (pre_tokens - preserved_tokens - 1.0).max(100.0);
    let summary = trim_text_to_token_budget(
        &budget,
        &summary,
        summary_budget.min(max_summary_tokens),
        true,
        None,
    )?;
    let post_tokens = estimate_tokens(&budget, &summary)? + preserved_tokens;
    let source_hash = if window.to_summarize.is_empty() {
        None
    } else {
        Some(
            store
                .conversation_messages_source_hash(
                    window
                        .to_summarize
                        .iter()
                        .map(|message| message.message.id.clone())
                        .collect(),
                )
                .await
                .map_err(conversation_error)?,
        )
    };
    let now = store.identity_clock().now_iso();
    if status == "ok"
        && let (Some(source_hash), Some(first), Some(last)) = (
            source_hash.as_deref(),
            window.to_summarize.first(),
            window.to_summarize.last(),
        )
    {
        store
            .write_summary(ConversationSummaryInput {
                session_id: canonical_session_id.clone(),
                covers_from_seq: first.message.seq as f64,
                covers_to_seq: last.message.seq as f64,
                source_hash: source_hash.to_owned(),
                summary_text: summary.clone(),
                model: None,
                summary_id: None,
                now: Some(now.clone()),
            })
            .await
            .map_err(conversation_error)?;
    }
    let working_budget = budget.evaluate_working(&WorkingContextBudgetInput {
        model_ref: None,
        working_context_tokens: pre_tokens,
        static_context_tokens: None,
        live_configuration_tokens: None,
        runtime_state_tokens: None,
        compaction_prompt_reserve_tokens: None,
        overrides: ContextBudgetOverrides::default(),
    });
    let snapshot = ContextCompactionSnapshot {
        schema: "butler.context.compaction.v1",
        snapshot_id: store.identity_clock().id("cmp"),
        session_id: canonical_session_id,
        trigger: "manual",
        status,
        created_at: now,
        model_ref: None,
        model_context_window_tokens: resolved_budget.context_window_tokens,
        pre_estimated_tokens: pre_tokens,
        post_estimated_tokens: post_tokens,
        summarized_event_range: EventRange {
            first_event_id: window.to_summarize.first().map(event_id),
            last_event_id: window.to_summarize.last().map(event_id),
            event_count: window.to_summarize.len(),
        },
        preserved_suffix_event_ids: window.preserved.iter().map(event_id).collect(),
        summarized_message_range: MessageRange {
            first_message_id: window
                .to_summarize
                .first()
                .map(|message| message.message.id.clone()),
            last_message_id: window
                .to_summarize
                .last()
                .map(|message| message.message.id.clone()),
            from_seq: window
                .to_summarize
                .first()
                .map(|message| message.message.seq),
            to_seq: window
                .to_summarize
                .last()
                .map(|message| message.message.seq),
            message_count: window.to_summarize.len(),
        },
        preserved_suffix_message_ids: window
            .preserved
            .iter()
            .map(|message| message.message.id.clone())
            .collect(),
        source_hash,
        summary,
        provenance: window
            .to_summarize
            .iter()
            .take(20)
            .map(|message| message.message.id.clone())
            .collect(),
        diagnostics: diagnostics.clone(),
        region_tokens: RegionTokens {
            working_context_tokens: pre_tokens,
            available_working_context_tokens: working_budget.available_working_context_tokens,
            used_working_ratio: working_budget.used_working_ratio,
            static_context_tokens: working_budget.static_context_tokens,
            live_configuration_tokens: working_budget.live_configuration_tokens,
            runtime_state_tokens: working_budget.runtime_state_tokens,
            compaction_prompt_reserve_tokens: working_budget.compaction_prompt_reserve_tokens,
        },
        known_gaps: Vec::new(),
    };
    append_snapshot(butler_data, &snapshot)?;
    let pre_tokens = snapshot.pre_estimated_tokens;
    let post_tokens = snapshot.post_estimated_tokens;
    metrics.append_context_compaction_metric(&CompactionMetricEvent {
        schema: "butler.context-compaction-metric.v1",
        ts: now_epoch_millis(),
        session_id: snapshot.session_id.clone(),
        snapshot_id: snapshot.snapshot_id.clone(),
        trigger: snapshot.trigger,
        status: snapshot.status,
        duration_ms: u64::try_from(started.elapsed().as_millis().min(u128::from(u64::MAX)))
            .unwrap_or(u64::MAX),
        model_ref: snapshot.model_ref.clone(),
        pre_estimated_tokens: pre_tokens,
        post_estimated_tokens: post_tokens,
        reduction_ratio: if pre_tokens > 0.0 {
            (1.0 - post_tokens / pre_tokens).max(0.0)
        } else {
            0.0
        },
        diagnostics,
        raw_text_stored: false,
    })?;
    Ok(snapshot)
}

fn event_id(message: &ConversationMessageWithParts) -> String {
    message
        .message
        .source_ref
        .clone()
        .unwrap_or_else(|| message.message.id.clone())
}

fn now_epoch_millis() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        * 1_000.0
}

#[expect(
    clippy::needless_pass_by_value,
    reason = "map_err/iterator adapter taking owned values"
)]
fn conversation_error(error: crate::conversation::ConversationError) -> ContextError {
    ContextError::new("context_conversation_error", error.to_string())
}
