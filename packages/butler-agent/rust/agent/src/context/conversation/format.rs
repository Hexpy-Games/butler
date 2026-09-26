use std::collections::HashMap;
use std::sync::Arc;

use indexmap::IndexMap;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::context::{ContextError, ContextResult};
use crate::conversation::*;
use crate::json::stringify;

use super::parts::to_context_message;
use super::types::*;

const REQUIRED_RECENT_SEMANTIC_TURNS: usize = 8;

pub(crate) fn compile_prompt_material_context_plan(
    material: &PromptMaterial,
    options: &PromptMaterialRenderOptions,
) -> ContextResult<ConversationPromptContextPlan> {
    let capacity = options.max_tokens.floor().max(1.0);
    let current = options
        .current_request
        .as_ref()
        .map(|value| {
            Ok(ConversationCurrentRequestAtom {
                id: format!("current_request:{}", value.id),
                source_hash: string_hash(&value.text),
                serialized_tokens: serialized_upper_bound(&value.text)?,
                text: value.text.clone(),
            })
        })
        .transpose()?;
    let messages = material
        .semantic_tail
        .iter()
        .filter(|item| {
            options
                .exclude_source_ref
                .as_ref()
                .is_none_or(|v| item.message.source_ref.as_ref() != Some(v))
                && options
                    .exclude_turn_id
                    .as_ref()
                    .is_none_or(|v| item.message.turn_id.as_ref() != Some(v))
        })
        .collect::<Vec<_>>();
    let turns = semantic_turn_atoms(
        &messages,
        &material.turns,
        &material.outcomes,
        options.include_tools != Some(false),
    )?;
    let required_start = turns.len().saturating_sub(REQUIRED_RECENT_SEMANTIC_TURNS);
    let required = turns[required_start..].to_vec();
    let optional = turns[..required_start]
        .iter()
        .rev()
        .cloned()
        .collect::<Vec<_>>();
    let header = "## Recent Conversation";
    let mut used = serialized_upper_bound(header)?
        + required.iter().map(|v| v.serialized_tokens).sum::<usize>();
    let mut selected_optional = Vec::new();
    for turn in &optional {
        if used as f64 + turn.serialized_tokens as f64 > capacity {
            break;
        }
        selected_optional.push(turn.clone());
        used += turn.serialized_tokens;
    }
    let mut summaries = Vec::new();
    if options.include_summaries != Some(false) {
        for summary in material.summaries.iter().rev() {
            let atom = summary_atom(summary)?;
            if used as f64 + atom.serialized_tokens as f64 > capacity {
                break;
            }
            used += atom.serialized_tokens;
            summaries.push(atom);
        }
    }
    summaries.reverse();
    let rendered_turns = selected_optional
        .iter()
        .rev()
        .chain(required.iter())
        .cloned()
        .collect::<Vec<_>>();
    let mut body = summaries.iter().map(render_summary).collect::<Vec<_>>();
    for turn in &rendered_turns {
        body.extend(render_turn(turn)?);
    }
    body.retain(|line| !crate::public_text::trim_js_whitespace(line).is_empty());
    let rendered = if body.is_empty() {
        String::new()
    } else {
        std::iter::once(header.to_owned())
            .chain(body)
            .collect::<Vec<_>>()
            .join("\n")
    };
    let selected_atom_ids = current
        .iter()
        .map(|v| v.id.clone())
        .chain(summaries.iter().map(|v| v.id.clone()))
        .chain(rendered_turns.iter().map(|v| v.id.clone()))
        .collect();
    Ok(ConversationPromptContextPlan {
        session_id: material.session_id.clone(),
        measurement: "serialized_utf8_upper_bound",
        capacity_tokens: capacity,
        current_request: current,
        required_turns: required,
        optional_turns: optional,
        selected_optional_turns: selected_optional,
        selected_summaries: summaries,
        selected_atom_ids,
        compiled_input_tokens: if rendered.is_empty() {
            0
        } else {
            serialized_upper_bound(&rendered)?
        },
        rendered,
    })
}

fn semantic_turn_atoms(
    messages: &[&ConversationMessageWithParts],
    turns: &[ConversationTurn],
    outcomes: &[TurnOutcomeCapsule],
    include_tools: bool,
) -> ContextResult<Vec<Arc<ConversationSemanticTurnAtom>>> {
    let status: HashMap<&str, &str> = turns
        .iter()
        .map(|v| (v.id.as_str(), v.status.as_str()))
        .collect();
    let outcome: HashMap<&str, &TurnOutcomeCapsule> =
        outcomes.iter().map(|v| (v.turn_id.as_str(), v)).collect();
    let mut groups: IndexMap<String, Vec<&ConversationMessageWithParts>> = IndexMap::new();
    for message in messages {
        let key = message.message.turn_id.as_ref().map_or_else(
            || format!("message:{}", message.message.id),
            |id| format!("turn:{id}"),
        );
        groups.entry(key).or_default().push(message);
    }
    groups
        .into_values()
        .map(|group| {
            let Some(first) = group.first() else {
                return Err(ContextError::new(
                    "context_group_empty",
                    "Conversation group is empty",
                ));
            };
            let Some(last) = group.last() else {
                return Err(ContextError::new(
                    "context_group_empty",
                    "Conversation group is empty",
                ));
            };
            let turn_id = first.message.turn_id.clone();
            let id = turn_id.as_ref().map_or_else(
                || format!("conversation_message:{}", first.message.id),
                |v| format!("conversation_turn:{v}"),
            );
            let status = turn_id
                .as_deref()
                .and_then(|v| status.get(v).copied())
                .unwrap_or("unknown")
                .to_owned();
            let messages = group
                .iter()
                .map(|v| to_context_message(v, include_tools))
                .collect::<Vec<_>>();
            let outcome = turn_id
                .as_deref()
                .and_then(|v| outcome.get(v).copied())
                .cloned();
            let rendered = render_turn_fields(
                &id,
                turn_id.as_deref(),
                &status,
                &messages,
                outcome.as_ref(),
            )?;
            Ok(Arc::new(ConversationSemanticTurnAtom {
                id,
                turn_id,
                status,
                source_hash: source_hash(&group)?,
                first_seq: first.message.seq,
                last_seq: last.message.seq,
                serialized_tokens: serialized_upper_bound(&rendered.join("\n"))?,
                messages,
                outcome,
            }))
        })
        .collect()
}

fn render_turn(turn: &ConversationSemanticTurnAtom) -> ContextResult<Vec<String>> {
    render_turn_fields(
        &turn.id,
        turn.turn_id.as_deref(),
        &turn.status,
        &turn.messages,
        turn.outcome.as_ref(),
    )
}
fn render_turn_fields(
    id: &str,
    turn_id: Option<&str>,
    status: &str,
    messages: &[ConversationContextMessage],
    outcome: Option<&TurnOutcomeCapsule>,
) -> ContextResult<Vec<String>> {
    let mut lines = vec![format!("turn {} status {status}", turn_id.unwrap_or(id))];
    if let Some(outcome) = outcome {
        lines.push(render_outcome(outcome)?);
    }
    lines.extend(
        messages
            .iter()
            .filter(|v| !crate::public_text::trim_js_whitespace(&v.text).is_empty())
            .map(|v| format!("{}: {}", v.speaker, v.text)),
    );
    Ok(lines)
}

fn render_outcome(outcome: &TurnOutcomeCapsule) -> ContextResult<String> {
    let mut body = Map::new();
    body.insert("source_hash".into(), outcome.source_hash.clone().into());
    body.insert(
        "request_message_id".into(),
        option_string(&outcome.request_message_id),
    );
    body.insert(
        "public_assistant_message_id".into(),
        option_string(&outcome.public_assistant_message_id),
    );
    body.insert(
        "evidence_refs".into(),
        serde_json::to_value(&outcome.evidence_refs).map_err(json_error)?,
    );
    body.insert(
        "unresolved_obligations".into(),
        serde_json::to_value(&outcome.unresolved_obligations).map_err(json_error)?,
    );
    body.insert(
        "continuation".into(),
        outcome
            .continuation
            .clone()
            .map(Value::Object)
            .unwrap_or(Value::Null),
    );
    body.insert("safe_code".into(), option_string(&outcome.safe_code));
    let kind = match outcome.outcome {
        TurnOutcomeKind::Delivered => "delivered",
        TurnOutcomeKind::Failed => "failed",
        TurnOutcomeKind::Cancelled => "cancelled",
        TurnOutcomeKind::Recoverable => "recoverable",
    };
    Ok(format!(
        "outcome {kind} generation {}: {}",
        js_number(outcome.generation)?,
        stringify(&Value::Object(body)).map_err(json_error)?
    ))
}

fn source_hash(messages: &[&ConversationMessageWithParts]) -> ContextResult<String> {
    let payload = messages
        .iter()
        .map(|message| {
            let mut value = Map::new();
            value.insert("id".into(), message.message.id.clone().into());
            value.insert("turn_id".into(), option_string(&message.message.turn_id));
            value.insert("seq".into(), message.message.seq.into());
            value.insert("role".into(), enum_text(role_text(message.message.role)));
            value.insert(
                "status".into(),
                enum_text(status_text(message.message.status)),
            );
            value.insert(
                "parts".into(),
                Value::Array(
                    message
                        .parts
                        .iter()
                        .map(|part| {
                            let mut item = Map::new();
                            item.insert("id".into(), part.id.clone().into());
                            item.insert("kind".into(), enum_text(part_kind_text(part.kind)));
                            item.insert("content_json".into(), part.content_json.clone());
                            item.insert("tool_call_id".into(), option_string(&part.tool_call_id));
                            item.insert(
                                "parent_tool_call_id".into(),
                                option_string(&part.parent_tool_call_id),
                            );
                            item.insert("status".into(), enum_text(status_text(part.status)));
                            Value::Object(item)
                        })
                        .collect(),
                ),
            );
            Value::Object(value)
        })
        .collect::<Vec<_>>();
    Ok(hash_bytes(
        stringify(&Value::Array(payload))
            .map_err(json_error)?
            .as_bytes(),
    ))
}

fn summary_atom(summary: &ConversationSummary) -> ContextResult<ConversationSummaryAtom> {
    let mut atom = ConversationSummaryAtom {
        summary_id: summary.id.clone(),
        covers_from_seq: summary.covers_from_seq,
        covers_to_seq: summary.covers_to_seq,
        source_hash: summary.source_hash.clone(),
        text: summary.summary_text.clone(),
        id: format!("conversation_summary:{}", summary.id),
        serialized_tokens: 0,
    };
    atom.serialized_tokens = serialized_upper_bound(&render_summary(&atom))?;
    Ok(atom)
}
fn render_summary(value: &ConversationSummaryAtom) -> String {
    format!(
        "summary {} seq {}-{}: {}",
        value.summary_id,
        number_display(value.covers_from_seq),
        number_display(value.covers_to_seq),
        crate::public_text::trim_js_whitespace(&value.text)
    )
}

fn serialized_upper_bound(value: &str) -> ContextResult<usize> {
    Ok(stringify(&Value::String(value.to_owned()))
        .map_err(json_error)?
        .len())
}
fn string_hash(value: &str) -> String {
    hash_bytes(value.as_bytes())
}
fn hash_bytes(value: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(value))
}
fn option_string(value: &Option<String>) -> Value {
    value.clone().map(Value::String).unwrap_or(Value::Null)
}
fn json_error(e: impl std::fmt::Display) -> ContextError {
    ContextError::new("context_json_error", e.to_string())
}
fn number_display(v: f64) -> String {
    serde_json::Number::from_f64(v)
        .map(Value::Number)
        .and_then(|value| crate::json::stringify(&value).ok())
        .unwrap_or_else(|| v.to_string())
}
fn js_number(v: f64) -> ContextResult<String> {
    serde_json::Number::from_f64(v)
        .map(Value::Number)
        .ok_or_else(|| ContextError::new("context_number_invalid", "invalid context number"))
        .and_then(|v| stringify(&v).map_err(json_error))
}

fn enum_text(value: &'static str) -> Value {
    Value::String(value.into())
}
fn role_text(value: ConversationRole) -> &'static str {
    match value {
        ConversationRole::System => "system",
        ConversationRole::Developer => "developer",
        ConversationRole::User => "user",
        ConversationRole::Assistant => "assistant",
        ConversationRole::Tool => "tool",
    }
}
fn status_text(value: ConversationStatus) -> &'static str {
    match value {
        ConversationStatus::Pending => "pending",
        ConversationStatus::Complete => "complete",
        ConversationStatus::Failed => "failed",
        ConversationStatus::Compacted => "compacted",
    }
}
fn part_kind_text(value: ConversationPartKind) -> &'static str {
    match value {
        ConversationPartKind::Text => "text",
        ConversationPartKind::AttachmentRef => "attachment_ref",
        ConversationPartKind::ToolCall => "tool_call",
        ConversationPartKind::ToolResult => "tool_result",
        ConversationPartKind::SummaryRef => "summary_ref",
        ConversationPartKind::MessageContent => "message_content",
    }
}
