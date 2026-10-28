//! Deterministic, read-only history rendering with a bounded content-version cache.
use crate::context::{ContextBudgetSnapshot, ContextResult, ConversationPromptContextPlan};
use butler_models::models::TokenEstimateInput;
use butler_turn::conversation::{HistoryWindow, omitted_history_notice as omitted_notice};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    sync::{LazyLock, Mutex},
};

static RENDERED: LazyLock<Mutex<VecDeque<(String, String)>>> =
    LazyLock::new(|| Mutex::new(VecDeque::new()));
const CACHE_TURNS: usize = 256;
const VERBATIM_TURNS: usize = 4;
mod trim;
pub(crate) use trim::HistoryStarts;

pub(super) fn render(
    window: &HistoryWindow,
    plan: &ConversationPromptContextPlan,
    cap: usize,
    snapshot: &ContextBudgetSnapshot<'_>,
    model_ref: Option<&str>,
    history: (&str, &HistoryStarts),
) -> ContextResult<(String, Vec<String>)> {
    let charge = |text: &str| {
        snapshot
            .estimate(TokenEstimateInput::Text(text), model_ref)
            .map(|estimate| butler_core::json::saturating_usize(estimate.tokens.ceil()))
    };
    let turns: Vec<_> = plan
        .optional_turns
        .iter()
        .rev()
        .chain(&plan.required_turns)
        .collect();
    let rendered = render_cached(window, &turns)?;
    let summaries = summaries(plan);
    let key = format!("{}:{model_ref:?}:{cap}", history.0);
    let (dropped, mut prefix) = trim::select(
        window,
        &turns,
        &rendered,
        &summaries,
        cap,
        &charge,
        history.1.get(&key).as_ref(),
    )?;
    let mut rendered = rendered[dropped..].to_vec();
    let mut text = join(&prefix, &rendered);
    if !fits(&text, cap, &charge)? {
        // Pathological individual turns can exceed the entire budget. Preserve
        // four turn identities and both speakers, with explicit excerpt markers.
        // Summaries must not crowd the newest request/reply.
        if let Some(summaries) = prefix
            .strip_suffix(&summaries)
            .filter(|_| !summaries.is_empty())
        {
            prefix = summaries.trim_end_matches('\n').to_owned();
        }
        let room = cap.saturating_sub(charge(&prefix)?);
        let per_turn = room / rendered.len().max(1);
        rendered = turns
            .iter()
            .skip(dropped)
            .map(|turn| render_excerpted(turn, window, per_turn, &charge))
            .collect::<ContextResult<Vec<_>>>()?;
        text = join(&prefix, &rendered);
    }
    if !fits(&text, cap, &charge)? {
        return Ok((String::new(), Vec::new()));
    }
    if let Some(turn) = turns.get(dropped) {
        history.1.record(
            key,
            trim::HistoryStart {
                first: turn.turn_id.as_ref().unwrap_or(&turn.id).clone(),
                prefix,
                summaries,
            },
        );
    }
    let ids = turns
        .iter()
        .skip(dropped)
        .map(|turn| turn.turn_id.as_ref().unwrap_or(&turn.id).clone())
        .collect();
    Ok((text, ids))
}

fn summaries(plan: &ConversationPromptContextPlan) -> String {
    plan.selected_summaries
        .iter()
        .map(|summary| {
            format!(
                "summary {} seq {}-{}: {}",
                summary.summary_id, summary.covers_from_seq, summary.covers_to_seq, summary.text
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn fits(
    text: &str,
    cap: usize,
    charge: &dyn Fn(&str) -> ContextResult<usize>,
) -> ContextResult<bool> {
    // Both local estimators charge at most one token per UTF-8 byte. This
    // proves a small projection fits without initializing the tokenizer;
    // larger projections still use the model's exact estimator.
    Ok(text.len() <= cap || charge(text)? <= cap)
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
    charge: &dyn Fn(&str) -> ContextResult<usize>,
) -> ContextResult<String> {
    let completed = completed_at(window, turn);
    let mut low = 0;
    let mut high = turn
        .messages
        .iter()
        .map(|m| m.text.encode_utf16().count())
        .max()
        .unwrap_or(0);
    let target = cap.saturating_sub(2);
    while low < high {
        let middle = low + (high - low).div_ceil(2);
        let candidate = render_excerpted_at(turn, completed, middle)?;
        if charge(&candidate)? <= target {
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
    if std::env::var("BUTLER_STARTUP_TRACE").as_deref() == Ok("1") {
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

fn prefix_text(omitted: usize, digest: &str, summaries: &str) -> String {
    let notice = if omitted > 0 {
        omitted_notice(omitted)
    } else {
        String::new()
    };
    [notice.as_str(), digest, summaries]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn extend_digest(
    digest: &str,
    turn: &crate::context::ConversationSemanticTurnAtom,
    cap: usize,
    charge: &dyn Fn(&str) -> ContextResult<usize>,
) -> ContextResult<String> {
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
    bounded_digest(
        &[digest, &line]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        cap,
        charge,
    )
}

fn bounded_digest(
    digest: &str,
    cap: usize,
    charge: &dyn Fn(&str) -> ContextResult<usize>,
) -> ContextResult<String> {
    if digest.is_empty() {
        return Ok(String::new());
    }
    let mut lines = digest
        .lines()
        .map(|line| Ok((line, charge(&format!("{line}\n"))?)))
        .collect::<ContextResult<VecDeque<_>>>()?;
    let mut used: usize = lines.iter().map(|(_, cost)| cost).sum();
    while used > cap {
        let Some((_, cost)) = lines.pop_front() else {
            break;
        };
        used = used.saturating_sub(cost);
    }
    let mut text = lines
        .iter()
        .map(|(line, _)| *line)
        .collect::<Vec<_>>()
        .join("\n");
    while !lines.is_empty() && charge(&text)? > cap {
        lines.pop_front();
        text = lines
            .iter()
            .map(|(line, _)| *line)
            .collect::<Vec<_>>()
            .join("\n");
    }
    Ok(text)
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
        rendered.push(cached(&version, || render_condensed(turn, window))?);
    }
    Ok(rendered)
}
