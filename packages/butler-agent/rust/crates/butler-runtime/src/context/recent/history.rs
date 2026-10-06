//! A window move reuses canonical summaries; subsequent requests only read them.
use crate::context::{ContextBudgetSnapshot, ContextConversation, ContextResult};
use butler_turn::conversation::{ConversationSummary, ConversationSummaryInput, HistoryWindow};

pub(super) async fn summarize(
    owner: &ContextConversation,
    mut window: HistoryWindow,
    cap: usize,
    budget: &ContextBudgetSnapshot<'_>,
) -> ContextResult<HistoryWindow> {
    while !window.dropped.is_empty() {
        for messages in window
            .dropped
            .chunk_by(|a, b| a.message.seq + 1 == b.message.seq)
        {
            summarize_range(owner, &window.material.session_id, messages, budget).await?;
        }
        let summaries = owner
            .store()
            .read_history_summaries(&window.material.session_id, cap)
            .await
            .map_err(conversation_error)?;
        window = window.with_summaries(summaries, cap);
    }
    Ok(window)
}

async fn summarize_range(
    owner: &ContextConversation,
    session: &str,
    messages: &[butler_turn::conversation::ConversationMessageWithParts],
    budget: &ContextBudgetSnapshot<'_>,
) -> ContextResult<ConversationSummary> {
    let (Some(first), Some(last)) = (messages.first(), messages.last()) else {
        return Err(crate::context::ContextError::new(
            crate::context::ContextCode::ContextGroupEmpty,
            "Empty summary range",
        ));
    };
    let resolved = budget.resolve(None, &crate::context::ContextBudgetOverrides::default());
    let chunk_budget = (resolved.context_window_tokens * 0.20).floor().max(500.0);
    let summary_budget = (resolved.context_window_tokens * 0.15)
        .floor()
        .clamp(200.0, 1200.0);
    let started = std::time::Instant::now();
    let hash =
        butler_turn::conversation::summary_source_hash(messages).map_err(conversation_error)?;
    let hashed = started.elapsed();
    let summary = crate::context::compaction::algorithm::build_summary(
        messages,
        budget,
        chunk_budget,
        summary_budget,
        &mut Vec::new(),
    )?;
    let built = started.elapsed();
    let result = owner
        .store()
        .write_summary(ConversationSummaryInput {
            session_id: session.to_owned(),
            covers_from_seq: first.message.seq as f64,
            covers_to_seq: last.message.seq as f64,
            source_hash: hash.clone(),
            summary_text: summary,
            model: None,
            summary_id: Some(format!("csm_history_{}", hash.replace(':', "_"))),
            now: None,
        })
        .await
        .map_err(conversation_error);
    if std::env::var("BUTLER_E2E_STARTUP_TRACE").as_deref() == Ok("1") {
        let written = started.elapsed();
        let _ = tokio::task::spawn_blocking(move || {
            eprintln!(
                "[history-summary] hash_us={} build_us={} write_us={}",
                hashed.as_micros(),
                built.saturating_sub(hashed).as_micros(),
                written.saturating_sub(built).as_micros()
            );
        })
        .await;
    }
    result
}

fn conversation_error(
    error: butler_turn::conversation::ConversationError,
) -> crate::context::ContextError {
    crate::context::ContextError::new(
        crate::context::ContextCode::ContextConversationError,
        error.to_string(),
    )
    .with_source(error)
}

pub(super) async fn trace(
    elapsed: std::time::Duration,
    read: std::time::Duration,
    summary: std::time::Duration,
) {
    if std::env::var("BUTLER_E2E_STARTUP_TRACE").as_deref() == Ok("1") {
        let _ = tokio::task::spawn_blocking(move || {
            eprintln!(
                "[history-projection] elapsed_us={} read_us={} summary_us={}",
                elapsed.as_micros(),
                read.as_micros(),
                summary.as_micros()
            );
        })
        .await;
    }
}
