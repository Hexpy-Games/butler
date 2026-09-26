//! Deterministic, provider-free summary and message-window algorithm.

use std::collections::{HashMap, HashSet};

use crate::{
    context::{ContextBudgetSnapshot, ContextResult, trim_text_to_token_budget},
    conversation::{ConversationMessageWithParts, ConversationPartKind, ConversationRole},
    models::TokenEstimateInput,
};

pub(super) struct CompactionWindow<'a> {
    pub(super) to_summarize: &'a [ConversationMessageWithParts],
    pub(super) preserved: &'a [ConversationMessageWithParts],
}

pub(super) fn compaction_window(
    messages: &[ConversationMessageWithParts],
    preserve_last_messages: usize,
) -> CompactionWindow<'_> {
    if messages.is_empty() {
        return CompactionWindow {
            to_summarize: &[],
            preserved: &[],
        };
    }
    let mut boundary = messages.len().saturating_sub(preserve_last_messages.max(2));
    let mut groups: HashMap<String, ToolGroup> = HashMap::new();
    for (index, message) in messages.iter().enumerate() {
        for part in &message.parts {
            let Some(id) = part
                .tool_call_id
                .as_deref()
                .or(part.parent_tool_call_id.as_deref())
            else {
                continue;
            };
            if id.is_empty() {
                continue;
            }
            let group = groups.entry(id.to_owned()).or_default();
            if group.indexes.last().copied() != Some(index) {
                group.indexes.push(index);
            }
            group.has_call |= part.kind == ConversationPartKind::ToolCall;
            group.has_result |= part.kind == ConversationPartKind::ToolResult;
        }
    }
    for group in groups.values() {
        let Some(first) = group.indexes.first().copied() else {
            continue;
        };
        let before = group.indexes.iter().any(|index| *index < boundary);
        let after = group.indexes.iter().any(|index| *index >= boundary);
        if (before && after) || (before && group.has_call && !group.has_result) {
            boundary = boundary.min(first);
        }
    }
    CompactionWindow {
        to_summarize: &messages[..boundary],
        preserved: &messages[boundary..],
    }
}

#[derive(Default)]
struct ToolGroup {
    indexes: Vec<usize>,
    has_call: bool,
    has_result: bool,
}

pub(super) fn build_summary(
    messages: &[ConversationMessageWithParts],
    budget: &ContextBudgetSnapshot<'_>,
    chunk_budget: f64,
    summary_budget: f64,
    diagnostics: &mut Vec<String>,
) -> ContextResult<String> {
    if messages.is_empty() {
        diagnostics.push("no_messages_to_summarize".into());
        return Ok(String::new());
    }
    if estimate_tokens(budget, &joined_message_text(messages))? <= chunk_budget {
        return summarize_messages(messages, budget, summary_budget);
    }
    diagnostics.push("hierarchical_chunk_compaction".into());
    let mut summaries = Vec::new();
    for (index, chunk) in chunk_messages(messages, budget, chunk_budget)?
        .iter()
        .enumerate()
    {
        let chunk_summary =
            summarize_messages(chunk, budget, (summary_budget / 2.0).floor().max(250.0))?;
        summaries.push(format!("Chunk {}: {chunk_summary}", index + 1));
    }
    trim_text_to_token_budget(budget, &summaries.join("\n\n"), summary_budget, true, None)
}

fn summarize_messages(
    messages: &[ConversationMessageWithParts],
    budget: &ContextBudgetSnapshot<'_>,
    max_tokens: f64,
) -> ContextResult<String> {
    let lines = messages.iter().map(message_text).collect::<Vec<_>>();
    let mut seen = HashSet::new();
    let mut candidates = lines
        .iter()
        .take(4)
        .chain(lines.iter().rev().take(4).rev())
        .filter(|line| seen.insert((*line).clone()))
        .map(|line| format!("- {line}"))
        .collect::<Vec<_>>();
    candidates.insert(
        0,
        format!("Canonical messages summarized: {}.", messages.len()),
    );
    trim_text_to_token_budget(budget, &candidates.join("\n"), max_tokens, true, None)
}

fn chunk_messages<'a>(
    messages: &'a [ConversationMessageWithParts],
    budget: &ContextBudgetSnapshot<'_>,
    chunk_budget: f64,
) -> ContextResult<Vec<&'a [ConversationMessageWithParts]>> {
    let mut chunks = Vec::new();
    let mut start = 0;
    let mut used = 0.0;
    for (index, message) in messages.iter().enumerate() {
        let tokens = estimate_tokens(budget, &message_text(message))?;
        if index > start && used + tokens > chunk_budget {
            chunks.push(&messages[start..index]);
            start = index;
            used = 0.0;
        }
        used += tokens;
    }
    if start < messages.len() {
        chunks.push(&messages[start..]);
    }
    Ok(chunks)
}

fn message_text(message: &ConversationMessageWithParts) -> String {
    let role = match message.message.role {
        ConversationRole::Assistant => "butler",
        ConversationRole::System => "system",
        ConversationRole::Developer => "developer",
        ConversationRole::User => "user",
        ConversationRole::Tool => "tool",
    };
    let parts = message
        .parts
        .iter()
        .filter_map(|part| match part.kind {
            ConversationPartKind::Text => object_string(&part.content_json, "text"),
            ConversationPartKind::AttachmentRef => {
                let name = object_string(&part.content_json, "fileName")
                    .or_else(|| object_string(&part.content_json, "filename"));
                let id = object_string(&part.content_json, "id");
                let details = [name, id]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join(":");
                Some(format!(
                    "[attachment:{}]",
                    if details.is_empty() { "ref" } else { &details }
                ))
            }
            ConversationPartKind::ToolCall => {
                let name = object_string(&part.content_json, "safeToolName")
                    .or_else(|| object_string(&part.content_json, "toolName"))
                    .or_else(|| object_string(&part.content_json, "name"))
                    .unwrap_or_else(|| "tool".into());
                Some(format!(
                    "[tool_call:{name}:{}]",
                    part.tool_call_id.as_deref().unwrap_or("unknown")
                ))
            }
            ConversationPartKind::ToolResult => {
                let result = if part
                    .content_json
                    .get("ok")
                    .and_then(serde_json::Value::as_bool)
                    == Some(false)
                {
                    "failed"
                } else {
                    "complete"
                };
                Some(format!(
                    "[tool_result:{result}:{}]",
                    part.parent_tool_call_id
                        .as_deref()
                        .or(part.tool_call_id.as_deref())
                        .unwrap_or("unknown")
                ))
            }
            ConversationPartKind::SummaryRef => Some("[summary_ref]".into()),
            ConversationPartKind::MessageContent => None,
        })
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>();
    if parts.is_empty() {
        format!("{role}: [empty semantic message]")
    } else {
        format!("{role}: {}", parts.join(" "))
    }
}

fn object_string(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

pub(super) fn joined_message_text(messages: &[ConversationMessageWithParts]) -> String {
    messages
        .iter()
        .map(message_text)
        .collect::<Vec<_>>()
        .join("\n")
}

pub(super) fn estimate_tokens(
    budget: &ContextBudgetSnapshot<'_>,
    text: &str,
) -> ContextResult<f64> {
    Ok(budget
        .estimate(TokenEstimateInput::Text(text), None)?
        .tokens)
}
