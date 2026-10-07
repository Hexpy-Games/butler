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
const VERBATIM_TURNS: usize = 4;
const MAX_EXCERPT_CHARS: usize = 4_000;

pub(super) fn render(
    window: &HistoryWindow,
    plan: &ConversationPromptContextPlan,
    cap: usize,
) -> ContextResult<String> {
    let turns: Vec<_> = plan
        .optional_turns
        .iter()
        .rev()
        .chain(&plan.required_turns)
        .collect();
    let mut rendered = render_cached(window, &turns)?;
    let mut digest = window.digest.clone();
    let mut summaries = String::new();
    for summary in &plan.selected_summaries {
        summaries.push_str(&format!(
            "\nsummary {} seq {}-{}: {}",
            summary.summary_id, summary.covers_from_seq, summary.covers_to_seq, summary.text
        ));
    }
    let mut prefix = format!("{digest}{summaries}");
    let mut text = join(&prefix, &rendered);
    if charged(&text)? > cap {
        rendered = plan
            .optional_turns
            .iter()
            .rev()
            .chain(&plan.required_turns)
            .map(|turn| render_condensed(turn, window))
            .collect::<ContextResult<Vec<_>>>()?;
        text = join(&prefix, &rendered);
    }

    let mut dropped = 0;
    while charged(&text)? > cap && rendered.len() > VERBATIM_TURNS {
        if let Some(turn) = turns.get(dropped) {
            digest = extend_digest(&digest, turn, cap / 10);
        }
        dropped += 1;
        rendered.remove(0);
        prefix = format!("{digest}{summaries}");
        text = join(&prefix, &rendered);
    }

    // Keep stepping down the verbatim guarantee. Each removed turn joins the
    // dropped-range digest, and retained turn strings remain content-local.
    while charged(&text)? > cap && rendered.len() > 1 {
        if let Some(turn) = turns.get(dropped) {
            digest = extend_digest(&digest, turn, cap / 10);
        }
        dropped += 1;
        rendered.remove(0);
        prefix = format!("{digest}{summaries}");
        text = join(&prefix, &rendered);
    }

    if charged(&text)? > cap && rendered.len() == 1 {
        let Some(turn) = turns.last() else {
            return Ok(String::new());
        };
        // Summaries are optional and must not crowd the newest request/reply.
        summaries.clear();
        prefix = digest.clone();
        rendered[0] = render_excerpted(turn, window, cap)?;
        text = join(&prefix, &rendered);
        if charged(&text)? > cap {
            // The digest is older context. Keep the newest turn bounded even
            // when the digest's escaping overhead consumes the remaining room.
            prefix.clear();
            text = join(&prefix, &rendered);
        }
    }

    if charged(&text)? > cap {
        // The fixed envelope itself exceeds pathological caps; do not fail prompt
        // assembly over history size.
        return Ok(String::new());
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
    let mut lines = vec![turn_header(turn, completed)];
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

fn render_excerpted(
    turn: &crate::context::ConversationSemanticTurnAtom,
    window: &HistoryWindow,
    cap: usize,
) -> ContextResult<String> {
    let completed = completed_at(window, turn);
    let mut low = 0;
    let mut high = MAX_EXCERPT_CHARS.min(cap);
    let target = cap.saturating_sub(cap / 5);
    while low < high {
        let middle = low + (high - low).div_ceil(2);
        let candidate = render_excerpted_at(turn, completed, middle)?;
        if charged(&candidate)? <= target {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    render_excerpted_at(turn, completed, low)
}

fn render_excerpted_at(
    turn: &crate::context::ConversationSemanticTurnAtom,
    completed: Option<&str>,
    max_chars: usize,
) -> ContextResult<String> {
    let mut lines = vec![turn_header(turn, completed)];
    if let Some(outcome) = &turn.outcome {
        lines.push(crate::context::conversation::render_outcome(outcome)?);
    }
    if let Some(request) = turn
        .messages
        .iter()
        .find(|message| message.role == butler_turn::conversation::ConversationRole::User)
    {
        lines.push(format!(
            "{}: {}",
            request.speaker,
            main_excerpt(request, max_chars)
        ));
    }
    if let Some(reply) = turn
        .messages
        .iter()
        .rev()
        .find(|message| message.role == butler_turn::conversation::ConversationRole::Assistant)
    {
        lines.push(format!(
            "{}: {}",
            reply.speaker,
            main_excerpt(reply, max_chars)
        ));
    }
    let tool_messages = turn
        .messages
        .iter()
        .filter(|message| is_tool_only(message))
        .count();
    if tool_messages > 0 {
        lines.push(format!("tool: [{tool_messages} recorded tool messages]"));
    }
    Ok(lines.join("\n"))
}

fn turn_header(
    turn: &crate::context::ConversationSemanticTurnAtom,
    completed: Option<&str>,
) -> String {
    let mut header = format!(
        "turn {} status {}",
        turn.turn_id.as_deref().unwrap_or(&turn.id),
        turn.status
    );
    if let Some(completed) = completed {
        header.push_str(&format!(" completed {completed}"));
    }
    header
}

fn completed_at<'a>(
    window: &'a HistoryWindow,
    turn: &crate::context::ConversationSemanticTurnAtom,
) -> Option<&'a str> {
    window
        .material
        .turns
        .iter()
        .find(|candidate| Some(&candidate.id) == turn.turn_id.as_ref())
        .filter(|candidate| window.late_turn_ids.contains(&candidate.id))
        .and_then(|candidate| candidate.completed_at.as_deref())
}

fn is_tool_only(message: &crate::context::ConversationContextMessage) -> bool {
    !message.parts.is_empty()
        && message.parts.iter().all(|part| {
            matches!(
                part.kind,
                butler_turn::conversation::ConversationPartKind::ToolCall
                    | butler_turn::conversation::ConversationPartKind::ToolResult
            )
        })
}

fn main_excerpt(message: &crate::context::ConversationContextMessage, max_chars: usize) -> String {
    let cost = message.text.encode_utf16().count()
        + message.created_at.encode_utf16().count()
        + message.conversation_message_id.encode_utf16().count()
        + 32;
    if cost <= max_chars {
        return message.text.clone();
    }
    let units = max_chars.saturating_sub(32);
    format!(
        "{}...",
        butler_core::public_text::trim_js_whitespace_end(crate::context::prefix_utf16(
            &message.text,
            units
        ))
    )
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

fn render_condensed(
    turn: &crate::context::ConversationSemanticTurnAtom,
    window: &HistoryWindow,
) -> ContextResult<String> {
    let mut turn = turn.clone();
    let mut tool_messages = 0;
    turn.messages.retain(|message| {
        let tool_only = is_tool_only(message);
        tool_messages += usize::from(tool_only);
        !tool_only
    });
    let completed = completed_at(window, &turn);
    let mut text = render_turn(&turn, completed)?;
    if tool_messages > 0 {
        text.push_str(&format!("\ntool: [{tool_messages} recorded tool messages]"));
    }
    Ok(text)
}

pub(super) fn document(history: String) -> ContextResult<butler_turn::btcc::ContextSection> {
    Ok(butler_turn::btcc::ContextSection {
        id: "recent-conversation".into(),
        title: "Recent Conversation".into(),
        content: history,
        region: Some("working_context".into()),
        projection_class: "mandatory_hot_cache".into(),
        scope_kind: "session".into(),
        source: None,
    })
}

fn charged(text: &str) -> ContextResult<usize> {
    serde_json::to_string(text)
        .map(|value| value.len() + "## Conversation history\n".len())
        .map_err(|e| ContextError::new(ContextCode::ContextJsonError, e.to_string()))
}

fn extend_digest(
    digest: &str,
    turn: &crate::context::ConversationSemanticTurnAtom,
    cap: usize,
) -> String {
    let request = turn
        .messages
        .iter()
        .find(|m| m.role == butler_turn::conversation::ConversationRole::User)
        .map_or("", |m| m.text.as_str())
        .replace(['\r', '\n'], " ");
    let mut end = request.len().min(160);
    while !request.is_char_boundary(end) {
        end -= 1;
    }
    let line = format!(
        "dropped turn {}: {}",
        turn.turn_id.as_deref().unwrap_or(&turn.id),
        request.get(..end).unwrap_or_default()
    );
    let mut lines: VecDeque<_> = digest
        .lines()
        .map(str::to_owned)
        .chain(std::iter::once(line))
        .collect();
    while lines
        .iter()
        .map(|s| serde_json::to_string(s).map_or(usize::MAX, |v| v.len() + 1))
        .sum::<usize>()
        > cap
    {
        lines.pop_front();
    }
    lines.into_iter().collect::<Vec<_>>().join("\n")
}

fn render_cached(
    window: &HistoryWindow,
    turns: &[&std::sync::Arc<crate::context::ConversationSemanticTurnAtom>],
) -> ContextResult<Vec<String>> {
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
            Sha256::digest(
                turn.outcome
                    .as_ref()
                    .map(crate::context::conversation::render_outcome)
                    .transpose()?
                    .unwrap_or_default()
            )
        );
        rendered.push(cached(&version, || render_turn(turn, completed))?);
    }
    Ok(rendered)
}
