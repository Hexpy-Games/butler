//! Read-only context-monitor projection; it never builds the source checkpoint.

use std::{fs, path::Path};

use serde_json::{Value, json};

use crate::{
    context,
    models::{ModelCatalog, ModelConfiguration, NativeStatusModels},
};
use std::sync::Arc;

use super::stream::{number, visit_jsonl};

pub(super) async fn read_context_monitor(data_root: &Path, models: &NativeStatusModels) -> Value {
    read_context_for_session(
        data_root,
        "butler/main",
        &models.model_ref,
        Arc::clone(&models.configuration),
        Arc::clone(&models.catalog),
    )
    .await
}

pub(super) async fn read_context_for_session(
    data_root: &Path,
    session_id: &str,
    model_ref: &str,
    configuration: Arc<ModelConfiguration>,
    catalog: Arc<ModelCatalog>,
) -> Value {
    let mut events = 0_u64;
    let mut parse_errors = 0_u64;
    let mut latest_prompt: Option<Value> = None;
    let mut latest_turn: Option<Value> = None;
    let path = data_root.join("metrics/context-monitor.jsonl");
    let malformed = visit_jsonl(&path, |_, parsed| {
        let Ok(value) = parsed else { return };
        if !valid_context_metric(&value) {
            parse_errors += 1;
            return;
        }
        if value["sessionId"] != session_id {
            return;
        }
        events += 1;
        let target = if value["kind"] == "prompt_assembly" {
            &mut latest_prompt
        } else {
            &mut latest_turn
        };
        if target.as_ref().is_none_or(|current| {
            number(value.get("ts")).unwrap_or(0.0) >= number(current.get("ts")).unwrap_or(0.0)
        }) {
            *target = Some(value);
        }
    });
    parse_errors += malformed as u64;
    let latest_prompt = latest_prompt.map(|mut event| {
        event["estimatedTokens"] =
            json!(rough_tokens(number(event.get("totalChars")).unwrap_or(0.0)));
        event
    });
    let latest_turn = latest_turn.map(|mut event| {
        event["estimatedTokens"] = json!(rough_tokens(
            number(event.get("totalPromptChars")).unwrap_or(0.0)
        ));
        event
    });
    let prompt_chars = latest_prompt
        .as_ref()
        .and_then(|event| number(event.get("totalChars")))
        .unwrap_or(0.0);
    let turn_chars = latest_turn
        .as_ref()
        .and_then(|event| number(event.get("totalPromptChars")))
        .unwrap_or(0.0);
    let total_chars = prompt_chars + turn_chars;
    let transcript = context::read_status_transcript_summary(data_root, session_id);
    let transcript_bytes = transcript.bytes.map_or(0.0, |bytes| bytes as f64);
    let transcript = transcript_value(&transcript);
    let status_facts = context::read_status_conversation_facts(data_root, session_id);
    let conversation = conversation_value(&status_facts.conversation);
    let conversation_tokens = number(conversation.get("promptTokenEstimate"));
    let estimated_tokens = rough_tokens(total_chars).max(conversation_tokens.unwrap_or(0.0));
    let budget = context::evaluate_status_budget(
        configuration,
        catalog,
        latest_turn
            .as_ref()
            .and_then(|event| event.get("model"))
            .and_then(Value::as_str)
            .or(Some(model_ref)),
        estimated_tokens,
    )
    .await;
    let pressure = budget.map_or_else(
        |_| json!({ "level": "unknown", "thresholdState": "unknown", "totalChars": total_chars, "estimatedTokens": estimated_tokens, "usedRatio": null, "availability": "context_budget_unavailable" }),
        |budget| budget_value(&budget, prompt_chars, turn_chars, total_chars, estimated_tokens, transcript_bytes, conversation_tokens),
    );
    json!({
        "sessionId": session_id,
        "telemetry": { "events": events, "parseErrors": parse_errors },
        "latestPromptAssembly": latest_prompt,
        "latestTurn": latest_turn,
        "transcript": transcript,
        "conversation": conversation,
        "pressure": pressure,
        "privacy": { "rawTextStored": false }
    })
}

pub(super) async fn render_context_estimate(
    resources: &Path,
    data_root: &Path,
    models: &NativeStatusModels,
) -> String {
    let system_prompt = rough_tokens_text(&read_joined(&[
        resources.join("prompts/butler.md"),
        resources.join("eol.md"),
        data_root.join("personas/active.md"),
    ]));
    let memory = rough_tokens_text(&read_joined(&[
        data_root.join("memory/user-profile.md"),
        data_root.join("memory/hot/cache.md"),
        data_root.join("memory/rules/INDEX.md"),
    ]));
    let status_facts = context::read_status_conversation_facts(data_root, "butler/main");
    let model_ref = match &status_facts.active_session {
        context::StatusFact::Available(Some(session)) if !session.model_ref.trim().is_empty() => {
            session.model_ref.as_str()
        }
        _ => models.model_ref.as_str(),
    };
    let messages = match status_facts.active_transcript_tokens {
        context::StatusFact::Available(tokens) => Some(tokens as f64),
        context::StatusFact::Unavailable(_) => None,
    };
    let total = system_prompt + memory + messages.unwrap_or(0.0);
    let budget = context::evaluate_status_budget(
        std::sync::Arc::clone(&models.configuration),
        std::sync::Arc::clone(&models.catalog),
        Some(model_ref),
        total,
    )
    .await;
    let Ok(budget) = budget else {
        return format!(
            "## Context Estimate\nmodel: {}\nbudget: unavailable\nsystem prompt: {}\nmemory: {}\nmessages: unavailable\ntotal: unavailable\nused ratio: unavailable\nthreshold: unavailable\nreserved output: unavailable\nreserved tool: unavailable\nfree before autocompact: unavailable",
            model_ref,
            display_count(system_prompt),
            display_count(memory),
        );
    };
    let compact_at =
        (budget.config.context_window_tokens * budget.config.auto_compact_threshold_ratio).floor();
    let messages_text = messages
        .map(display_count)
        .unwrap_or_else(|| "unavailable".into());
    let total_text = if messages.is_some() {
        display_count(total)
    } else {
        "unavailable".into()
    };
    let ratio_text = if messages.is_some() {
        format!("{:.1}%", budget.used_ratio * 100.0)
    } else {
        "unavailable".into()
    };
    format!(
        "## Context Estimate\nmodel: {}\nbudget: {}\nsystem prompt: {}\nmemory: {}\nmessages: {}\ntotal: {}\nused ratio: {}\nthreshold: {}\nreserved output: {}\nreserved tool: {}\nfree before autocompact: {}",
        model_ref,
        display_count(budget.config.context_window_tokens),
        display_count(system_prompt),
        display_count(memory),
        messages_text,
        total_text,
        ratio_text,
        threshold_name(budget.threshold_state),
        display_count(budget.config.reserved_output_tokens),
        display_count(budget.config.reserved_tool_tokens),
        if messages.is_some() {
            display_count((compact_at - total).max(0.0))
        } else {
            "unavailable".into()
        },
    )
}

fn valid_context_metric(value: &Value) -> bool {
    let base = number(value.get("ts")).is_some()
        && value.get("sessionId").and_then(Value::as_str).is_some();
    match value.get("kind").and_then(Value::as_str) {
        Some("prompt_assembly") => {
            base && value.get("role").and_then(Value::as_str).is_some()
                && number(value.get("totalChars")).is_some()
                && value.get("sections").and_then(Value::as_array).is_some()
        }
        Some("runtime_turn") => {
            base && (value.get("model").is_some_and(Value::is_null)
                || value.get("model").and_then(Value::as_str).is_some())
                && number(value.get("totalPromptChars")).is_some()
                && number(value.get("promptContextChars")).is_some()
                && number(value.get("recentConversationChars")).is_some()
                && number(value.get("recallContextChars")).is_some()
                && number(value.get("inboundMessageChars")).is_some()
        }
        _ => false,
    }
}

fn budget_value(
    budget: &crate::context::ContextBudgetEvaluation,
    prompt_chars: f64,
    turn_chars: f64,
    total_chars: f64,
    estimated_tokens: f64,
    transcript_bytes: f64,
    conversation_tokens: Option<f64>,
) -> Value {
    json!({
        "level": match budget.pressure_level { crate::context::ContextPressureLevel::Low => "low", crate::context::ContextPressureLevel::Medium => "medium", crate::context::ContextPressureLevel::High => "high" },
        "thresholdState": threshold_name(budget.threshold_state),
        "totalChars": total_chars,
        "estimatedTokens": estimated_tokens,
        "contextWindowTokens": budget.config.context_window_tokens,
        "reservedOutputTokens": budget.config.reserved_output_tokens,
        "reservedToolTokens": budget.config.reserved_tool_tokens,
        "freeTokens": budget.free_tokens,
        "freeTokensAfterReserve": budget.free_tokens_after_reserve,
        "usedRatio": budget.used_ratio,
        "contributors": {
            "systemPromptChars": prompt_chars,
            "turnPromptChars": turn_chars,
            "semanticPromptTokens": conversation_tokens,
            "transcriptBytes": transcript_bytes
        }
    })
}

fn transcript_value(summary: &context::StatusTranscriptSummary) -> Value {
    let mut value = json!({
        "exists": summary.exists,
        "bytes": summary.bytes,
        "events": summary.events,
        "conversationEvents": summary.conversation_events,
        "latestTimestamp": summary.latest_timestamp,
        "parseErrors": summary.parse_errors
    });
    if let Some(reason) = &summary.unavailable_reason {
        value["availability"] = json!({ "status": "unavailable", "reason": reason });
    }
    value
}

fn conversation_value(summary: &context::StatusConversationSummary) -> Value {
    let mut value = json!({
        "exists": summary.exists,
        "sessionId": summary.session_id,
        "semanticMessages": summary.semantic_messages,
        "compactedMessages": summary.compacted_messages,
        "summaries": summary.summaries,
        "latestMessageTimestamp": summary.latest_message_timestamp,
        "promptTokenEstimate": summary.prompt_token_estimate
    });
    if let Some(reason) = &summary.unavailable_reason {
        value["availability"] = json!({ "status": "unavailable", "reason": reason });
    }
    value
}

fn read_joined(paths: &[std::path::PathBuf]) -> String {
    paths
        .iter()
        .filter_map(|path| fs::read_to_string(path).ok())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn rough_tokens(chars: f64) -> f64 {
    (chars / 4.0).ceil().max(0.0)
}

fn rough_tokens_text(text: &str) -> f64 {
    rough_tokens(text.encode_utf16().count() as f64)
}

fn display_count(value: f64) -> String {
    let digits = crate::json::saturating_u64(value.max(0.0).round()).to_string();
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    grouped
}

fn threshold_name(value: crate::context::ContextThresholdState) -> &'static str {
    match value {
        crate::context::ContextThresholdState::Normal => "normal",
        crate::context::ContextThresholdState::Warning => "warning",
        crate::context::ContextThresholdState::AutoCompact => "auto_compact",
        crate::context::ContextThresholdState::HardPressure => "hard_pressure",
    }
}
