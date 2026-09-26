//! Native Context status projection from owned budget and transcript facts.

use std::{fs, path::Path};

use serde_json::{Value, json};

use crate::{
    cognition::CognitionPathEnvironment,
    context::{
        ContextBudgetOverrides, ContextThresholdState, StatusFact, read_status_conversation_facts,
    },
    conversation::conversation_session_id_for_durable_session,
};

use super::{
    CliError, ResolvedInstallation, context_budget_owner, open_status_models, unavailable,
};

pub(super) async fn run(
    data_root: &Path,
    installation: &ResolvedInstallation,
) -> Result<(Value, String), CliError> {
    let models = open_status_models(data_root).await?;
    let facts = read_status_conversation_facts(
        data_root,
        &conversation_session_id_for_durable_session("butler/main"),
    );
    let active_model = match &facts.active_session {
        StatusFact::Available(Some(session)) if !session.model_ref.trim().is_empty() => {
            Some(session.model_ref.as_str())
        }
        StatusFact::Available(None)
        | StatusFact::Unavailable(_)
        | StatusFact::Available(Some(_)) => None,
    };
    let model_ref = active_model.unwrap_or(&models.model_ref);
    let budget_owner = context_budget_owner(&models);
    let budget_snapshot = budget_owner.snapshot().await.map_err(|_| {
        unavailable(
            "native_context_budget_unavailable",
            "Context budget facts are unavailable.",
        )
    })?;
    let budget = budget_snapshot.resolve(Some(model_ref), &ContextBudgetOverrides::default());

    // The source operator estimate reads these files, rather than a rendered
    // provider prompt. Keep this read-only projection on the same installed
    // resources and canonical memory path used by the native process.
    let system_prompt = rough_tokens(&joined_existing_text(&[
        installation.resources().join("prompts/butler.md"),
        installation.resources().join("eol.md"),
        data_root.join("personas/active.md"),
    ])?);
    let paths = CognitionPathEnvironment {
        cognition_home: std::env::var("BUTLER_COGNITION_HOME").ok(),
        memory_home: std::env::var("BUTLER_COGNITION_MEMORY_HOME").ok(),
    };
    let memory_root = paths.memory_root(data_root);
    let memory_files = rough_tokens(&joined_existing_text(&[
        memory_root.join("user-profile.md"),
        memory_root.join("hot/cache.md"),
        memory_root.join("rules/INDEX.md"),
    ])?);

    let mut unavailable_fields = Vec::new();
    let (messages, transcript_unavailable) = match facts.active_transcript_tokens {
        StatusFact::Available(tokens) => (Some(tokens), None),
        StatusFact::Unavailable(reason) => {
            unavailable_fields.push("messages");
            (None, Some(reason))
        }
    };
    let total = messages.map(|tokens| system_prompt + memory_files + tokens as f64);
    let evaluation = total.map(|tokens| {
        budget_snapshot.evaluate(Some(model_ref), tokens, &ContextBudgetOverrides::default())
    });
    if evaluation.is_none() {
        unavailable_fields.extend(["freeSpace", "total", "thresholdState", "usedRatio"]);
    }
    let unavailable = json!({
        "fields": unavailable_fields,
        "reasons": {
            "totalAndThresholds": evaluation.is_none().then_some("transcript_unavailable"),
            "messages": transcript_unavailable,
        }
    });
    let auto_compact = (budget.context_window_tokens * budget.auto_compact_threshold_ratio).floor();
    let data = json!({
        "model": model_ref,
        "budget": budget.context_window_tokens,
        "systemPrompt": system_prompt,
        "systemTools": 0,
        "mcpTools": 0,
        "customAgents": 0,
        "memoryFiles": memory_files,
        "skills": 0,
        "messages": messages,
        "freeSpace": total.map(|tokens| (auto_compact - tokens).max(0.0)),
        "autocompact": auto_compact,
        "total": total,
        "thresholdState": evaluation.as_ref().map(|value| threshold_name(value.threshold_state)),
        "usedRatio": evaluation.as_ref().map(|value| value.used_ratio),
        "reservedOutput": budget.reserved_output_tokens,
        "reservedTool": budget.reserved_tool_tokens,
        "availability": if evaluation.is_some() { "complete" } else { "partial" },
        "unavailable": unavailable,
    });
    let messages_text = messages
        .map(|value| value.to_string())
        .unwrap_or_else(|| "unavailable".into());
    let human = format!(
        "Context estimate for {model_ref}: budget={} messages={messages_text} total={}; threshold={}.",
        crate::json::saturating_u64(budget.context_window_tokens),
        total
            .map(|value| value.to_string())
            .unwrap_or_else(|| "unavailable".into()),
        evaluation
            .as_ref()
            .map(|value| threshold_name(value.threshold_state))
            .unwrap_or("unavailable"),
    );
    Ok((data, human))
}

fn joined_existing_text(paths: &[std::path::PathBuf]) -> Result<String, CliError> {
    let mut pieces = Vec::new();
    for path in paths {
        match fs::read_to_string(path) {
            Ok(text) if !text.is_empty() => pieces.push(text),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                return Err(unavailable(
                    "native_context_source_text_unavailable",
                    "Context source text could not be read.",
                ));
            }
        }
    }
    Ok(pieces.join("\n\n"))
}

fn rough_tokens(text: &str) -> f64 {
    text.encode_utf16().count().div_ceil(4) as f64
}

fn threshold_name(state: ContextThresholdState) -> &'static str {
    match state {
        ContextThresholdState::Normal => "normal",
        ContextThresholdState::Warning => "warning",
        ContextThresholdState::AutoCompact => "auto_compact",
        ContextThresholdState::HardPressure => "hard_pressure",
    }
}
