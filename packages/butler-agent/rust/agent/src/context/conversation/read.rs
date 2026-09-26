use indexmap::IndexMap;
use unicode_normalization::UnicodeNormalization;

use crate::context::{ContextError, ContextResult};
use crate::conversation::{
    AgentConversationStore, ConversationMessageWithParts, ConversationOriginKind, ReadAroundInput,
    conversation_session_id_for_durable_session, text_for_message,
};

use super::parts::{to_context_message, to_context_summary};
use super::types::*;

const DEFAULT_LIMIT: f64 = 10.0;
const MAX_LIMIT: f64 = 80.0;
const DEFAULT_MAX_CHARS: f64 = 4_000.0;
const MAX_CHARS: f64 = 12_000.0;

pub(crate) async fn canonical_conversation_session_id(
    store: &AgentConversationStore,
    runtime_session_id: &str,
    gateway: Option<&str>,
) -> ContextResult<String> {
    let runtime = crate::public_text::trim_js_whitespace(runtime_session_id);
    if runtime.is_empty() {
        return Ok(conversation_session_id_for_durable_session("butler/main"));
    }
    if store
        .get_session(runtime)
        .await
        .map_err(store_error)?
        .is_some()
    {
        return Ok(runtime.to_owned());
    }
    if let Some(gateway) = gateway
        .map(crate::public_text::trim_js_whitespace)
        .filter(|v| !v.is_empty())
        && let Some(bound) = store
            .get_session_by_gateway_binding(gateway, runtime)
            .await
            .map_err(store_error)?
    {
        return Ok(bound.id);
    }
    Ok(conversation_session_id_for_durable_session(runtime))
}

pub(crate) async fn read_conversation_context(
    store: &AgentConversationStore,
    input: ReadConversationContextInput,
) -> ContextResult<ConversationContextResult> {
    let (limit, max_chars) = input.validated_limits.as_ref().map_or(
        (
            clamp(input.limit, DEFAULT_LIMIT, 1.0, MAX_LIMIT),
            clamp(input.max_chars, DEFAULT_MAX_CHARS, 200.0, MAX_CHARS),
        ),
        |v| (v.limit, v.max_chars),
    );
    let direction = input
        .direction
        .unwrap_or(ConversationContextDirection::Around);
    let query = input
        .query
        .as_deref()
        .map(crate::public_text::trim_js_whitespace)
        .unwrap_or("")
        .to_owned();
    let canonical =
        canonical_conversation_session_id(store, &input.session_id, input.gateway.as_deref())
            .await?;
    let anchor = resolve_anchor(store, &canonical, &input).await?;
    let selected = select_messages(
        store,
        &canonical,
        anchor.as_ref().map(|v| v.message.id.as_str()),
        &query,
        direction,
        limit,
    )
    .await?;
    let selected = if input.validated_limits.is_some() {
        selected
            .into_iter()
            .filter(|v| {
                input.include_internal
                    || matches!(
                        v.message.origin_kind,
                        ConversationOriginKind::UserInput | ConversationOriginKind::AssistantPublic
                    )
            })
            .collect()
    } else {
        selected
    };
    let summaries = store
        .read_summaries(&canonical)
        .await
        .map_err(store_error)?
        .into_iter()
        .filter(|v| {
            v.covers_to_seq
                < selected
                    .first()
                    .map(|v| v.message.seq as f64)
                    .unwrap_or(f64::INFINITY)
        })
        .map(|v| to_context_summary(&v))
        .collect();
    let rendered = selected
        .iter()
        .map(|v| to_context_message(v, input.include_tools))
        .collect::<Vec<_>>();
    let rendered_count = rendered.len();
    let (messages, truncated) = apply_char_budget(rendered, max_chars);
    let requested_anchor = input
        .anchor_message_id
        .as_deref()
        .map(crate::public_text::trim_js_whitespace)
        .filter(|v| !v.is_empty())
        .map(str::to_owned);
    Ok(ConversationContextResult {
        ok: true,
        session_id: canonical,
        runtime_session_id: input.session_id,
        query: (!query.is_empty()).then_some(query),
        anchor_message_id: anchor.map(|v| v.message.id).or(requested_anchor),
        anchor_event_id: trim_option(input.anchor_event_id),
        direction,
        returned: messages.len(),
        truncated: truncated || rendered_count > messages.len(),
        messages,
        summaries,
    })
}

async fn resolve_anchor(
    store: &AgentConversationStore,
    session: &str,
    input: &ReadConversationContextInput,
) -> ContextResult<Option<ConversationMessageWithParts>> {
    if let Some(id) = input
        .anchor_message_id
        .as_deref()
        .map(crate::public_text::trim_js_whitespace)
        .filter(|v| !v.is_empty())
    {
        let message = store.read_message_by_id(id).await.map_err(store_error)?;
        if message
            .as_ref()
            .is_some_and(|v| v.message.session_id == session)
        {
            return Ok(message);
        }
    }
    if let Some(id) = input
        .anchor_event_id
        .as_deref()
        .map(crate::public_text::trim_js_whitespace)
        .filter(|v| !v.is_empty())
    {
        return store
            .read_message_by_source_ref(session, id)
            .await
            .map_err(store_error);
    }
    Ok(None)
}

async fn select_messages(
    store: &AgentConversationStore,
    session: &str,
    anchor: Option<&str>,
    query: &str,
    direction: ConversationContextDirection,
    limit: f64,
) -> ContextResult<Vec<ConversationMessageWithParts>> {
    if let Some(anchor) = anchor {
        return store
            .read_messages_around(ReadAroundInput {
                session_id: session.into(),
                anchor_message_id: Some(anchor.into()),
                direction: Some(direction_name(direction).into()),
                limit: Some(limit),
                include_compacted: false,
            })
            .await
            .map_err(store_error);
    }
    if query.is_empty() {
        return before(store, session, limit).await;
    }
    let terms = query_terms(query);
    let mut selected = store
        .read_context_query_selected(
            session.to_owned(),
            move |message| {
                let haystack = normalize(&text_for_message(message, false));
                terms.iter().any(|term| haystack.contains(term))
            },
            move |all| {
                let mut selected = IndexMap::new();
                for (index, _) in all.iter().enumerate().filter(|(_, (_, matched))| *matched) {
                    for selected_index in indices_around(
                        index,
                        all.len(),
                        direction,
                        crate::json::saturating_usize(limit),
                    ) {
                        selected.insert(all[selected_index].0.clone(), ());
                        if selected.len() >= crate::json::saturating_usize(limit) {
                            break;
                        }
                    }
                    if selected.len() >= crate::json::saturating_usize(limit) {
                        break;
                    }
                }
                selected.into_keys().collect()
            },
        )
        .await
        .map_err(store_error)?;
    if selected.is_empty() {
        before(store, session, limit).await
    } else {
        selected.sort_by_key(|v| v.message.seq);
        Ok(selected)
    }
}
async fn before(
    store: &AgentConversationStore,
    session: &str,
    limit: f64,
) -> ContextResult<Vec<ConversationMessageWithParts>> {
    store
        .read_messages_around(ReadAroundInput {
            session_id: session.into(),
            anchor_message_id: None,
            direction: Some("before".into()),
            limit: Some(limit),
            include_compacted: false,
        })
        .await
        .map_err(store_error)
}

fn normalize(value: &str) -> String {
    value.nfc().collect::<String>().to_lowercase()
}
fn query_terms(query: &str) -> Vec<String> {
    let normalized = normalize(query);
    let normalized = crate::public_text::trim_js_whitespace(&normalized).to_owned();
    if normalized.is_empty() {
        return vec![];
    }
    let mut values = IndexMap::new();
    values.insert(normalized.clone(), ());
    for value in normalized.split(|c: char| {
        crate::public_text::is_js_whitespace(c) || ",./!?()[]{}'\"`~:;|<>".contains(c)
    }) {
        let value = crate::public_text::trim_js_whitespace(value);
        if value.encode_utf16().count() >= 2 {
            values.insert(value.into(), ());
        }
    }
    values.into_keys().collect()
}
fn indices_around(
    anchor: usize,
    len: usize,
    direction: ConversationContextDirection,
    limit: usize,
) -> Vec<usize> {
    if len == 0 {
        return vec![];
    }
    match direction {
        ConversationContextDirection::Before => {
            let start = anchor.saturating_sub(limit.saturating_sub(1));
            (start..=anchor).collect()
        }
        ConversationContextDirection::After => {
            let end = (anchor + limit.saturating_sub(1)).min(len - 1);
            (anchor..=end).collect()
        }
        ConversationContextDirection::Around => {
            let before = limit.saturating_sub(1) / 2;
            let start = anchor.saturating_sub(before);
            let end = (start + limit.saturating_sub(1)).min(len - 1);
            let start = end.saturating_sub(limit.saturating_sub(1));
            (start..=end).collect()
        }
    }
}

pub(in crate::context) fn apply_char_budget(
    messages: Vec<ConversationContextMessage>,
    max_chars: f64,
) -> (Vec<ConversationContextMessage>, bool) {
    let max = crate::json::saturating_usize(max_chars.max(0.0));
    let mut selected = Vec::new();
    let mut used = 0;
    for mut message in messages {
        let cost = message.text.encode_utf16().count()
            + message.created_at.encode_utf16().count()
            + message.conversation_message_id.encode_utf16().count()
            + 32;
        if !selected.is_empty() && used + cost > max {
            return (selected, true);
        }
        if cost > max {
            let units = max.saturating_sub(32);
            message.text = crate::public_text::trim_js_whitespace_end(
                crate::context::prefix_utf16(&message.text, units),
            )
            .to_owned()
                + "...";
            selected.push(message);
            return (selected, true);
        }
        selected.push(message);
        used += cost;
    }
    (selected, false)
}
fn clamp(value: Option<f64>, fallback: f64, min: f64, max: f64) -> f64 {
    value
        .filter(|v| v.is_finite())
        .map(|v| v.floor().clamp(min, max))
        .unwrap_or(fallback)
}
fn direction_name(value: ConversationContextDirection) -> &'static str {
    match value {
        ConversationContextDirection::Before => "before",
        ConversationContextDirection::After => "after",
        ConversationContextDirection::Around => "around",
    }
}
fn trim_option(value: Option<String>) -> Option<String> {
    value
        .map(|v| crate::public_text::trim_js_whitespace(&v).to_owned())
        .filter(|v| !v.is_empty())
}
fn store_error(error: impl std::fmt::Display) -> ContextError {
    ContextError::new("context_conversation_read_error", error.to_string())
}
