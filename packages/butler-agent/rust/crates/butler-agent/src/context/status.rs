//! Read-only context budget evaluation shared by operational status views.

use std::sync::Arc;

use super::{ContextBudgetEnvironment, ContextBudgetOverrides, ContextBudgetOwner};
use butler_models::models::ModelCatalog;
use butler_models::models::ModelConfiguration;

/// The context budget for status views could not be evaluated.
#[derive(Debug, thiserror::Error)]
#[error("context_status_unavailable: {0}")]
pub(crate) struct StatusBudgetError(#[source] super::ContextError);

pub(crate) async fn evaluate_status_budget(
    configuration: Arc<ModelConfiguration>,
    catalog: Arc<ModelCatalog>,
    model_ref: Option<&str>,
    input_tokens: f64,
) -> Result<super::ContextBudgetEvaluation, StatusBudgetError> {
    let owner = ContextBudgetOwner::new(configuration, catalog, environment());
    let snapshot = owner.snapshot().await.map_err(StatusBudgetError)?;
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
