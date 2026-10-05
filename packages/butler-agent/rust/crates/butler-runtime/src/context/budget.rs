mod policy;
mod text;

pub use policy::*;
pub use text::*;

use std::sync::Arc;

use serde_json::{Map, Value};

use crate::context::ContextCode;
use crate::context::{ContextError, ContextResult};
use butler_models::models::{
    ModelCatalog, ModelCatalogError, ModelCatalogSnapshot, ModelConfiguration,
    ModelContextMetadataRead, TokenEstimate, TokenEstimateInput,
};

pub const WORKING_CONTEXT_AUTO_COMPACT_RATIO: f64 = 0.94;
pub const WORKING_CONTEXT_HARD_PRESSURE_RATIO: f64 = 0.985;

#[derive(Clone, Debug, Default)]
pub struct ContextBudgetEnvironment {
    pub context_window_tokens: Option<String>,
    pub reserved_output_tokens: Option<String>,
    pub reserved_tool_tokens: Option<String>,
    pub compaction_prompt_reserve_tokens: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct ContextBudgetOverrides {
    pub context_window_tokens: Option<Value>,
    pub reserved_output_tokens: Option<Value>,
    pub reserved_tool_tokens: Option<Value>,
    pub model_windows: Option<Map<String, Value>>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ContextBudgetConfig {
    pub context_window_tokens: f64,
    pub reserved_output_tokens: f64,
    pub reserved_tool_tokens: f64,
    pub warning_threshold_ratio: f64,
    pub auto_compact_threshold_ratio: f64,
    pub hard_threshold_ratio: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContextThresholdState {
    Normal,
    Warning,
    AutoCompact,
    HardPressure,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContextPressureLevel {
    Low,
    Medium,
    High,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ContextBudgetEvaluation {
    pub config: ContextBudgetConfig,
    pub model_ref: String,
    pub provider_id: String,
    pub model_id: String,
    pub input_tokens: f64,
    pub token_estimator: butler_models::models::TokenEstimatorKind,
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
pub struct WorkingContextBudgetEvaluation {
    pub config: ContextBudgetConfig,
    pub model_ref: String,
    pub provider_id: String,
    pub model_id: String,
    pub token_estimator: butler_models::models::TokenEstimatorKind,
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

pub struct ContextBudgetOwner {
    configuration: Arc<ModelConfiguration>,
    catalog: Arc<ModelCatalog>,
    environment: ContextBudgetEnvironment,
}

impl ContextBudgetOwner {
    pub fn new(
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

    /// The process model catalog the budget measures with.
    pub fn catalog(&self) -> &Arc<ModelCatalog> {
        &self.catalog
    }

    pub async fn snapshot(&self) -> ContextResult<ContextBudgetSnapshot<'_>> {
        self.snapshot_from(self.configuration.read_context_metadata().await)
    }

    /// Fresh snapshot for a caller already inside tracked blocking work.
    pub fn snapshot_blocking(&self) -> ContextResult<ContextBudgetSnapshot<'_>> {
        self.snapshot_from(self.configuration.read_context_metadata_blocking())
    }

    fn snapshot_from(
        &self,
        metadata: Result<ModelContextMetadataRead, ModelCatalogError>,
    ) -> ContextResult<ContextBudgetSnapshot<'_>> {
        let metadata = metadata.map_err(|error| {
            ContextError::new(ContextCode::ContextModelMetadataError, error.to_string())
                .with_source(error)
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
        let metadata = self
            .configuration
            .read_context_metadata()
            .await
            .map_err(|error| {
                ContextError::new(ContextCode::ContextModelMetadataError, error.to_string())
                    .with_source(error)
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
    models: Arc<ModelCatalogSnapshot>,
    provider_id: String,
}

impl OwnedDefaultTokenEstimator {
    pub(crate) fn estimate(&self, text: &str) -> ContextResult<TokenEstimate> {
        self.catalog
            .estimate_tokens(&self.models, TokenEstimateInput::Text(text), None)
            .map_err(|error| {
                ContextError::new(ContextCode::ContextTokenEstimateError, error.to_string())
                    .with_source(error)
            })
    }

    pub(crate) fn provider_id(&self) -> &str {
        &self.provider_id
    }
}

pub struct ContextBudgetSnapshot<'a> {
    pub(crate) config: Value,
    pub models: Arc<ModelCatalogSnapshot>,
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
            .map_err(|error| {
                ContextError::new(ContextCode::ContextTokenEstimateError, error.to_string())
                    .with_source(error)
            })
    }
}
