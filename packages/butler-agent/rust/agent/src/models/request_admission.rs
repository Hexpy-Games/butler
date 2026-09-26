//! Per-attempt physical provider request admission.

use bytes::Bytes;
use sha2::{Digest, Sha256};

use crate::btcc::{
    ModelRequestAdmissionCode, ModelRequestAdmissionError, ModelRequestContextPlan,
    ModelRoundError, RequestContextAdmission, RequestContextMeasurement,
};

use super::{
    ModelCatalog, ModelCatalogSnapshot, ProviderRequestConfigPort, TokenEstimateInput,
    parse_model_ref,
};

const IMAGE_TOKEN_ALLOWANCE: f64 = 8_192.0;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

pub(super) struct PreparedRequestAdmission<'a> {
    catalog: &'a ModelCatalog,
    config: &'a dyn ProviderRequestConfigPort,
    provider: &'a str,
    model_ref: &'a str,
    butler_data: Option<&'a str>,
    requested_output_tokens: Option<f64>,
    explicit_context_window_tokens: Option<f64>,
    explicit_max_output_tokens: Option<f64>,
    serialized: Bytes,
    tool_schema_bytes: usize,
    request_hash: String,
}

pub(super) struct AdmissionReceipt {
    pub plan: ModelRequestContextPlan,
    pub request_hash: String,
}

pub(super) struct PrepareAdmissionInput<'a, 'body> {
    pub catalog: &'a ModelCatalog,
    pub config: &'a dyn ProviderRequestConfigPort,
    pub provider: &'a str,
    pub model_ref: &'a str,
    pub butler_data: Option<&'a str>,
    pub requested_output_tokens: Option<f64>,
    pub context_window_tokens: Option<f64>,
    pub max_output_tokens: Option<f64>,
    pub body: &'body serde_json::Value,
    pub serialized: Bytes,
}

impl<'a> PreparedRequestAdmission<'a> {
    pub(super) fn new(input: PrepareAdmissionInput<'a, '_>) -> Result<Self, ModelRoundError> {
        let tool_schema_bytes = input
            .body
            .get("tools")
            .filter(|value| !value.is_null())
            .map(crate::json::stringify)
            .transpose()
            .map_err(serialization_failure)?
            .map_or(2, |value| value.len());
        Ok(Self {
            catalog: input.catalog,
            config: input.config,
            provider: input.provider,
            model_ref: input.model_ref,
            butler_data: input.butler_data,
            requested_output_tokens: input.requested_output_tokens,
            explicit_context_window_tokens: input.context_window_tokens,
            explicit_max_output_tokens: input.max_output_tokens,
            serialized: input.serialized.clone(),
            tool_schema_bytes,
            request_hash: format!("{:x}", Sha256::digest(&input.serialized)),
        })
    }

    pub(super) fn admit(&self) -> Result<AdmissionReceipt, ModelRoundError> {
        let snapshot = self.config.sizing_snapshot(self.butler_data)?;
        self.admit_with_snapshot(&snapshot)
    }

    fn admit_with_snapshot(
        &self,
        snapshot: &ModelCatalogSnapshot,
    ) -> Result<AdmissionReceipt, ModelRoundError> {
        let parsed = parse_model_ref(self.model_ref);
        let capacity_model = if self.provider == "openai" {
            parsed
                .model_id
                .strip_suffix("-codex")
                .unwrap_or(&parsed.model_id)
        } else {
            &parsed.model_id
        };
        let lookup_ref = format!("{}/{}", self.provider, capacity_model);
        let admitted_model_ref = format!("{}/{}", self.provider, parsed.model_id);
        let metadata = snapshot.find_model_metadata(Some(&lookup_ref));
        let metadata_matches = metadata.as_ref().is_some_and(|value| {
            value.provider_id == self.provider && value.model_id == capacity_model
        });
        let context_window = positive_integer(self.explicit_context_window_tokens).or_else(|| {
            metadata_matches
                .then(|| {
                    metadata
                        .as_ref()
                        .and_then(|value| positive_integer(value.context_window_tokens))
                })
                .flatten()
        });
        let max_output = positive_integer(self.explicit_max_output_tokens).or_else(|| {
            metadata_matches
                .then(|| {
                    metadata
                        .as_ref()
                        .and_then(|value| positive_integer(value.max_output_tokens))
                })
                .flatten()
        });
        let context_window = match context_window {
            Some(value) => value,
            None if self.provider == "opencode-go" => MAX_SAFE_INTEGER,
            None => {
                return Err(admission_error(
                    ModelRequestAdmissionCode::MetadataUnknown,
                    format!(
                        "No exact context capacity is registered for {}/{}.",
                        self.provider, parsed.model_id
                    ),
                    None,
                ));
            }
        };
        let requested_output = positive_integer(self.requested_output_tokens)
            .or(max_output)
            .unwrap_or(0.0);
        let input_capacity = (context_window - requested_output).min(context_window);
        let serialized = std::str::from_utf8(&self.serialized).map_err(serialization_failure)?;
        let mut projected = None;
        let mut image_count = 0;
        if serialized
            .as_bytes()
            .windows(b"data:image/".len())
            .any(|window| window.eq_ignore_ascii_case(b"data:image/"))
        {
            let body: serde_json::Value =
                serde_json::from_slice(&self.serialized).map_err(serialization_failure)?;
            projected = Some(
                crate::json::stringify_with_string_projection(&body, |text| {
                    image_data_url(text).then(|| {
                        image_count += 1;
                        format!("[image input bytes={}]", text.len())
                    })
                })
                .map_err(serialization_failure)?,
            );
        }
        let token_input = projected.as_deref().unwrap_or(serialized);
        let estimated = self
            .catalog
            .estimate_tokens(
                snapshot,
                TokenEstimateInput::Text(token_input),
                Some(&admitted_model_ref),
            )
            .map_err(|error| ModelRoundError::InvocationFailure {
                code: Some("model_request_token_estimate_failed".into()),
                message: error.to_string(),
            })?
            .tokens
            + f64::from(image_count) * IMAGE_TOKEN_ALLOWANCE;
        drop(projected);
        let admission = if estimated <= input_capacity {
            RequestContextAdmission::Admitted
        } else {
            RequestContextAdmission::Reduce
        };
        let mut plan = ModelRequestContextPlan {
            request_id: format!("request-{}", &self.request_hash[..24]),
            turn_id: "unattributed".into(),
            generation: 0.0,
            model_ref: admitted_model_ref,
            context_window_tokens: context_window,
            requested_output_tokens: requested_output,
            max_input_tokens: None,
            provider_envelope_tokens: 0.0,
            input_capacity_tokens: input_capacity.max(0.0),
            measurement: RequestContextMeasurement::ModelTokenEstimate,
            required_atoms: Vec::new(),
            optional_atoms: Vec::new(),
            tool_schema_tokens: self.tool_schema_bytes as f64,
            compiled_input_tokens: estimated,
            budget_input_tokens: None,
            admission,
        };
        if max_output
            .is_some_and(|max| requested_output > max || requested_output >= context_window)
        {
            plan.admission = RequestContextAdmission::CannotFitRequired;
            return Err(admission_error(
                ModelRequestAdmissionCode::OutputCapacityExceeded,
                format!(
                    "Requested output capacity exceeds the registered limit for {}.",
                    plan.model_ref
                ),
                Some(plan),
            ));
        }
        if plan.admission != RequestContextAdmission::Admitted {
            return Err(admission_error(
                ModelRequestAdmissionCode::ContextCapacityExceeded,
                format!(
                    "Serialized model request does not fit the registered context capacity for {}.",
                    plan.model_ref
                ),
                Some(plan),
            ));
        }
        plan.budget_input_tokens = Some(estimated);
        Ok(AdmissionReceipt {
            plan,
            request_hash: self.request_hash.clone(),
        })
    }
}

fn positive_integer(value: Option<f64>) -> Option<f64> {
    value.filter(|value| value.is_finite() && *value > 0.0 && value.fract() == 0.0)
}

fn admission_error(
    code: ModelRequestAdmissionCode,
    message: String,
    plan: Option<ModelRequestContextPlan>,
) -> ModelRoundError {
    ModelRoundError::RequestAdmission(Box::new(ModelRequestAdmissionError {
        code,
        message,
        plan: plan.map(Box::new),
    }))
}

fn serialization_failure(error: impl std::fmt::Display) -> ModelRoundError {
    ModelRoundError::InvocationFailure {
        code: Some("model_request_serialization_failed".into()),
        message: error.to_string(),
    }
}

fn image_data_url(value: &str) -> bool {
    [
        "data:image/png;base64,",
        "data:image/jpeg;base64,",
        "data:image/webp;base64,",
        "data:image/gif;base64,",
    ]
    .iter()
    .any(|prefix| {
        value
            .get(..prefix.len())
            .is_some_and(|value| value.eq_ignore_ascii_case(prefix))
    })
}

#[cfg(test)]
mod tests;
