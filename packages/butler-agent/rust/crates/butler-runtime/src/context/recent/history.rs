//! Deterministic, read-only history rendering with a bounded content-version cache.
use crate::context::{ContextCode, ContextError, ContextResult, ConversationPromptContextPlan};
use butler_turn::conversation::HistoryWindow;
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    sync::{LazyLock, Mutex},
};

static RENDERED: LazyLock<Mutex<VecDeque<(String, String)>>> =
    LazyLock::new(|| Mutex::new(VecDeque::new()));
const CACHE_TURNS: usize = 256;

pub(super) fn render(
    window: &HistoryWindow,
    plan: &ConversationPromptContextPlan,
    cap: usize,
) -> ContextResult<String> {
    let turns: Vec<_> = plan
        .selected_optional_turns
        .iter()
        .rev()
        .chain(&plan.required_turns)
        .collect();
    let mut rendered = Vec::new();
    for turn in turns {
        let completed = window
            .material
            .turns
            .iter()
            .find(|t| Some(&t.id) == turn.turn_id.as_ref())
            .filter(|t| window.late_turn_ids.contains(&t.id))
            .and_then(|t| t.completed_at.as_deref());
        let version = format!(
            "{}:{}:{}:{:?}:{:x}",
            turn.id,
            turn.source_hash,
            turn.status,
            completed,
            Sha256::digest(turn.outcome.as_ref().map(crate::context::conversation::render_outcome).transpose()?.unwrap_or_default())
        );
        rendered.push(cached(&version, || render_turn(turn, completed))?);
    }
    let mut prefix = window.digest.clone();
    for summary in &plan.selected_summaries {
        prefix.push_str(&format!(
            "\nsummary {} seq {}-{}: {}",
            summary.summary_id, summary.covers_from_seq, summary.covers_to_seq, summary.text
        ));
    }
    let mut text = join(&prefix, &rendered);
    if text.len() > cap {
        rendered = plan.selected_optional_turns.iter().rev().chain(&plan.required_turns)
            .map(|turn| render_condensed(turn, window)).collect::<ContextResult<Vec<_>>>()?;
        text = join(&prefix, &rendered);
    }
    // Size estimates are deliberately conservative. This final check includes all
    // envelopes, digest and capsules, rather than trusting their estimates.
    while text.len() > cap && rendered.len() > 4 {
        rendered.remove(0);
        text = join(&prefix, &rendered);
    }
    if text.len() > cap {
        return Err(ContextError::new(
            ContextCode::ContextGroupEmpty,
            "Required conversation history exceeds budget",
        ));
    }
    Ok(text)
}

fn join(prefix: &str, turns: &[String]) -> String {
    std::iter::once(prefix)
        .chain(turns.iter().map(String::as_str))
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn cached(version: &str, render: impl FnOnce() -> ContextResult<String>) -> ContextResult<String> {
    if let Ok(cache) = RENDERED.lock()
        && let Some((_, text)) = cache.iter().find(|(key, _)| key == version)
    {
        return Ok(text.clone());
    }
    let text = render()?;
    if let Ok(mut cache) = RENDERED.lock() {
        if cache.len() == CACHE_TURNS {
            cache.pop_front();
        }
        cache.push_back((version.to_owned(), text.clone()));
    }
    Ok(text)
}

fn render_turn(
    turn: &crate::context::ConversationSemanticTurnAtom,
    completed: Option<&str>,
) -> ContextResult<String> {
    let mut lines = vec![format!(
        "turn {} status {}",
        turn.turn_id.as_deref().unwrap_or(&turn.id),
        turn.status
    )];
    if let Some(completed) = completed {
        lines[0].push_str(&format!(" completed {completed}"));
    }
    if let Some(outcome) = &turn.outcome {
        lines.push(crate::context::conversation::render_outcome(outcome)?);
    }
    lines.extend(
        turn.messages
            .iter()
            .filter(|m| !m.text.is_empty())
            .map(|m| format!("{}: {}", m.speaker, m.text)),
    );
    Ok(lines.join("\n"))
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

fn render_condensed(turn: &crate::context::ConversationSemanticTurnAtom, window: &HistoryWindow) -> ContextResult<String> {
    let mut turn = turn.clone();
    let mut tool_messages = 0;
    turn.messages.retain(|message| {
        let tool_only = !message.parts.is_empty() && message.parts.iter().all(|p|
            matches!(p.kind,butler_turn::conversation::ConversationPartKind::ToolCall | butler_turn::conversation::ConversationPartKind::ToolResult));
        tool_messages += usize::from(tool_only);
        !tool_only
    });
    let completed = window.material.turns.iter().find(|t|Some(&t.id)==turn.turn_id.as_ref())
        .filter(|t|window.late_turn_ids.contains(&t.id)).and_then(|t|t.completed_at.as_deref());
    let mut text = render_turn(&turn,completed)?;
    if tool_messages > 0 { text.push_str(&format!("\ntool: [{tool_messages} recorded tool messages]")); }
    Ok(text)
}
