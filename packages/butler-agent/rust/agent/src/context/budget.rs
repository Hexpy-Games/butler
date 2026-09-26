mod policy;
mod text;

pub(crate) use policy::*;
pub(crate) use text::*;

use std::sync::Arc;

use serde_json::{Map, Value};

use crate::context::{ContextError, ContextResult};
use crate::models::{
    ModelCatalog, ModelCatalogSnapshot, ModelConfiguration, TokenEstimate, TokenEstimateInput,
};

pub(crate) const WORKING_CONTEXT_AUTO_COMPACT_RATIO: f64 = 0.94;
pub(crate) const WORKING_CONTEXT_HARD_PRESSURE_RATIO: f64 = 0.985;

#[derive(Clone, Debug, Default)]
pub(crate) struct ContextBudgetEnvironment {
    pub context_window_tokens: Option<String>,
    pub reserved_output_tokens: Option<String>,
    pub reserved_tool_tokens: Option<String>,
    pub compaction_prompt_reserve_tokens: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct ContextBudgetOverrides {
    pub context_window_tokens: Option<Value>,
    pub reserved_output_tokens: Option<Value>,
    pub reserved_tool_tokens: Option<Value>,
    pub model_windows: Option<Map<String, Value>>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ContextBudgetConfig {
    pub context_window_tokens: f64,
    pub reserved_output_tokens: f64,
    pub reserved_tool_tokens: f64,
    pub warning_threshold_ratio: f64,
    pub auto_compact_threshold_ratio: f64,
    pub hard_threshold_ratio: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ContextThresholdState {
    Normal,
    Warning,
    AutoCompact,
    HardPressure,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ContextPressureLevel {
    Low,
    Medium,
    High,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ContextBudgetEvaluation {
    pub config: ContextBudgetConfig,
    pub model_ref: String,
    pub provider_id: String,
    pub model_id: String,
    pub input_tokens: f64,
    pub token_estimator: crate::models::TokenEstimatorKind,
    pub used_ratio: f64,
    pub free_tokens: f64,
    pub free_tokens_after_reserve: f64,
    pub threshold_state: ContextThresholdState,
    pub pressure_level: ContextPressureLevel,
    pub should_warn: bool,
    pub should_auto_compact: bool,
    pub should_hard_pressure: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct WorkingContextBudgetEvaluation {
    pub config: ContextBudgetConfig,
    pub model_ref: String,
    pub provider_id: String,
    pub model_id: String,
    pub token_estimator: crate::models::TokenEstimatorKind,
    pub working_context_tokens: f64,
    pub static_context_tokens: f64,
    pub live_configuration_tokens: f64,
    pub runtime_state_tokens: f64,
    pub compaction_prompt_reserve_tokens: f64,
    pub available_working_context_tokens: f64,
    pub used_working_ratio: f64,
    pub should_auto_compact: bool,
    pub should_hard_pressure: bool,
    pub usable_user_message_tokens: f64,
}

pub(crate) struct ContextBudgetOwner {
    configuration: Arc<ModelConfiguration>,
    catalog: Arc<ModelCatalog>,
    environment: ContextBudgetEnvironment,
}

impl ContextBudgetOwner {
    pub(crate) fn new(
        configuration: Arc<ModelConfiguration>,
        catalog: Arc<ModelCatalog>,
        environment: ContextBudgetEnvironment,
    ) -> Self {
        Self {
            configuration,
            catalog,
            environment,
        }
    }

    pub(crate) async fn snapshot(&self) -> ContextResult<ContextBudgetSnapshot<'_>> {
        let metadata = self.configuration.read_metadata().await.map_err(|error| {
            ContextError::new("context_model_metadata_error", error.to_string())
        })?;
        Ok(ContextBudgetSnapshot {
            config: metadata.config,
            models: metadata.catalog,
            catalog: &self.catalog,
            environment: &self.environment,
        })
    }

    /// One request-owned default-model snapshot, transferable into tracked
    /// blocking work without cloning the catalog or retaining a Turn.
    pub(crate) async fn owned_default_estimator(
        &self,
    ) -> ContextResult<OwnedDefaultTokenEstimator> {
        let metadata = self.configuration.read_metadata().await.map_err(|error| {
            ContextError::new("context_model_metadata_error", error.to_string())
        })?;
        Ok(OwnedDefaultTokenEstimator {
            catalog: Arc::clone(&self.catalog),
            provider_id: metadata.catalog.resolve_model_metadata(None).provider_id,
            models: metadata.catalog,
        })
    }
}

pub(crate) struct OwnedDefaultTokenEstimator {
    catalog: Arc<ModelCatalog>,
    models: ModelCatalogSnapshot,
    provider_id: String,
}

impl OwnedDefaultTokenEstimator {
    pub(crate) fn estimate(&self, text: &str) -> ContextResult<TokenEstimate> {
        self.catalog
            .estimate_tokens(&self.models, TokenEstimateInput::Text(text), None)
            .map_err(|error| ContextError::new("context_token_estimate_error", error.to_string()))
    }

    pub(crate) fn provider_id(&self) -> &str {
        &self.provider_id
    }
}

pub(crate) struct ContextBudgetSnapshot<'a> {
    pub(crate) config: Value,
    pub(crate) models: ModelCatalogSnapshot,
    catalog: &'a ModelCatalog,
    environment: &'a ContextBudgetEnvironment,
}

impl ContextBudgetSnapshot<'_> {
    pub(crate) fn estimate(
        &self,
        input: TokenEstimateInput<'_>,
        model_ref: Option<&str>,
    ) -> ContextResult<TokenEstimate> {
        self.catalog
            .estimate_tokens(&self.models, input, model_ref)
            .map_err(|error| ContextError::new("context_token_estimate_error", error.to_string()))
    }
}
