//! Read-only context budget evaluation shared by operational status views.

use std::sync::Arc;

use super::{ContextBudgetEnvironment, ContextBudgetOverrides, ContextBudgetOwner};
use crate::models::{ModelCatalog, ModelConfiguration};

pub(crate) async fn evaluate_status_budget(
    configuration: Arc<ModelConfiguration>,
    catalog: Arc<ModelCatalog>,
    model_ref: Option<&str>,
    input_tokens: f64,
) -> Result<super::ContextBudgetEvaluation, String> {
    let owner = ContextBudgetOwner::new(configuration, catalog, environment());
    let snapshot = owner
        .snapshot()
        .await
        .map_err(|error| format!("context_status_unavailable: {error}"))?;
    Ok(snapshot.evaluate(model_ref, input_tokens, &ContextBudgetOverrides::default()))
}

fn environment() -> ContextBudgetEnvironment {
    ContextBudgetEnvironment {
        context_window_tokens: env_value("BUTLER_CONTEXT_WINDOW_TOKENS"),
        reserved_output_tokens: env_value("BUTLER_CONTEXT_RESERVED_OUTPUT_TOKENS"),
        reserved_tool_tokens: env_value("BUTLER_CONTEXT_RESERVED_TOOL_TOKENS"),
        compaction_prompt_reserve_tokens: env_value(
            "BUTLER_CONTEXT_COMPACTION_PROMPT_RESERVE_TOKENS",
        ),
    }
}

fn env_value(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}
