//! Physical request facts crossing the provider/Turn boundary.
//!
//! Models owns capacity lookup, measurement and admission. BTCC only carries
//! the original failure through routing and applies its existing outer reducer.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct ContextAtomRef {
    pub kind: String,
    pub id: String,
    pub source_hash: String,
    pub required: bool,
    pub serialized_tokens: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RequestContextMeasurement {
    ModelTokenEstimate,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RequestContextAdmission {
    Admitted,
    Reduce,
    CannotFitRequired,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct ModelRequestContextPlan {
    pub request_id: String,
    pub turn_id: String,
    pub generation: f64,
    pub model_ref: String,
    pub context_window_tokens: f64,
    pub requested_output_tokens: f64,
    pub max_input_tokens: Option<f64>,
    pub provider_envelope_tokens: f64,
    pub input_capacity_tokens: f64,
    pub measurement: RequestContextMeasurement,
    pub required_atoms: Vec<ContextAtomRef>,
    pub optional_atoms: Vec<ContextAtomRef>,
    pub tool_schema_tokens: f64,
    pub compiled_input_tokens: f64,
    pub budget_input_tokens: Option<f64>,
    pub admission: RequestContextAdmission,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum ModelRequestAdmissionCode {
    #[serde(rename = "model_request_metadata_unknown")]
    MetadataUnknown,
    #[serde(rename = "model_request_output_capacity_exceeded")]
    OutputCapacityExceeded,
    #[serde(rename = "model_request_context_capacity_exceeded")]
    ContextCapacityExceeded,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ModelRequestAdmissionError {
    pub code: ModelRequestAdmissionCode,
    pub message: String,
    pub plan: Option<Box<ModelRequestContextPlan>>,
}

impl std::fmt::Display for ModelRequestAdmissionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ModelRequestAdmissionError {}
