//! Per-attempt physical provider request admission.

use bytes::Bytes;
use sha2::{Digest, Sha256};

use butler_turn::btcc::{
    ModelRequestAdmissionCode, ModelRequestAdmissionError, ModelRequestContextPlan,
    ModelRoundError, RequestContextAdmission, RequestContextMeasurement,
};

use super::{
    ModelCatalog, ModelCatalogSnapshot, ProviderRequestConfigPort, TokenEstimateInput,
    parse_model_ref,
};

pub(super) const IMAGE_TOKEN_ALLOWANCE: f64 = 8_192.0;
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
    token_input: Bytes,
    image_count: u32,
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
    pub(super) fn new(input: &PrepareAdmissionInput<'a, '_>) -> Result<Self, ModelRoundError> {
        let tool_schema_bytes = input
            .body
            .get("tools")
            .filter(|value| !value.is_null())
            .map(butler_core::json::stringify)
            .transpose()
            .map_err(serialization_failure)?
            .map_or(2, |value| value.len());
        let mut payloads = Vec::new();
        image_payloads(input.body, None, &mut payloads);
        let (token_input, image_count) = if payloads.is_empty() {
            (input.serialized.clone(), 0)
        } else {
            let (text, count) = project_images(input.body, &payloads)?;
            (Bytes::from(text), count)
        };
        Ok(Self {
            catalog: input.catalog,
            config: input.config,
            provider: input.provider,
            model_ref: input.model_ref,
            butler_data: input.butler_data,
            requested_output_tokens: input.requested_output_tokens,
            explicit_context_window_tokens: input.context_window_tokens,
            explicit_max_output_tokens: input.max_output_tokens,
            token_input,
            image_count,
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
        let token_input = std::str::from_utf8(&self.token_input).map_err(serialization_failure)?;
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
            + f64::from(self.image_count) * IMAGE_TOKEN_ALLOWANCE;
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

/// Image payloads are pixels, not text tokens. Every inline image costs the
/// same conservative allowance in pre-round sizing and physical request
/// admission on every carrier; its base64 is never estimated as text.
pub(super) fn image_token_projection(
    body: &serde_json::Value,
) -> Result<(String, u32), ModelRoundError> {
    let mut payloads = Vec::new();
    image_payloads(body, None, &mut payloads);
    project_images(body, &payloads)
}

fn project_images(
    body: &serde_json::Value,
    payloads: &[&str],
) -> Result<(String, u32), ModelRoundError> {
    let mut count = 0;
    let text = butler_core::json::stringify_with_string_projection(body, |text| {
        // Identity, not equality: only the payload strings located below.
        payloads
            .iter()
            .any(|payload| std::ptr::eq(*payload, text))
            .then(|| {
                count += 1;
                format!("[image input bytes={}]", text.len())
            })
    })
    .map_err(serialization_failure)?;
    Ok((text, count))
}

const IMAGE_DATA_URL_PREFIXES: [&str; 4] = [
    "data:image/png;base64,",
    "data:image/jpeg;base64,",
    "data:image/webp;base64,",
    "data:image/gif;base64,",
];

fn image_data_url(value: &str) -> bool {
    IMAGE_DATA_URL_PREFIXES.iter().any(|prefix| {
        value
            .get(..prefix.len())
            .is_some_and(|value| value.eq_ignore_ascii_case(prefix))
    })
}

fn image_mime(value: Option<&serde_json::Value>) -> bool {
    value
        .and_then(serde_json::Value::as_str)
        .is_some_and(|mime| {
            IMAGE_DATA_URL_PREFIXES.iter().any(|prefix| {
                prefix
                    .strip_prefix("data:")
                    .and_then(|rest| rest.strip_suffix(";base64,"))
                    .is_some_and(|known| known.eq_ignore_ascii_case(mime))
            })
        })
}

#[cfg(test)]
mod tests;

// The base64 of every inline image in a carrier body: OpenAI data URLs,
// Anthropic `"source":{"type":"base64","media_type",…,"data"}` and Gemini
// `inline_data`/`inlineData` parts. The body is already parsed during request
// construction, so ordinary history is walked once, never scanned byte by byte
// or parsed again for admission.
fn image_payloads<'v>(
    value: &'v serde_json::Value,
    key: Option<&str>,
    payloads: &mut Vec<&'v str>,
) {
    match value {
        serde_json::Value::String(text) if image_data_url(text) => payloads.push(text),
        serde_json::Value::Array(values) => {
            for value in values {
                image_payloads(value, None, payloads);
            }
        }
        serde_json::Value::Object(values) => {
            let inline = match key {
                Some("source") => {
                    values.get("type").and_then(serde_json::Value::as_str) == Some("base64")
                        && image_mime(values.get("media_type"))
                }
                Some("inline_data") => image_mime(values.get("mime_type")),
                Some("inlineData") => image_mime(values.get("mimeType")),
                _ => false,
            };
            for (key, value) in values {
                match value {
                    // Empty strings share one dangling pointer; never match them.
                    serde_json::Value::String(data)
                        if inline && key == "data" && !data.is_empty() =>
                    {
                        payloads.push(data);
                    }
                    _ => image_payloads(value, Some(key), payloads),
                }
            }
        }
        _ => {}
    }
}
