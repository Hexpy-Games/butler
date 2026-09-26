use super::ModelConfiguration;
use crate::btcc::{
    AdmissionModelCatalogPort, AdmissionModelCatalogSnapshot, AdmissionModelMetadata, BtccError,
    PortFuture, ReasoningEffort,
};

impl AdmissionModelCatalogPort for ModelConfiguration {
    fn snapshot(
        &self,
        requested_model_refs: Vec<String>,
    ) -> PortFuture<'_, AdmissionModelCatalogSnapshot> {
        Box::pin(async move {
            // Admission only needs metadata. It never reads or retains secrets.
            let facts = self
                .read_metadata()
                .await
                .map_err(|error| BtccError::new("model_catalog_failed", error.to_string()))?;
            let snapshot = facts.catalog;
            let metadata = requested_model_refs
                .into_iter()
                .map(|requested_model_ref| {
                    let model = snapshot.resolve_model_metadata(Some(&requested_model_ref));
                    AdmissionModelMetadata {
                        requested_model_ref,
                        provider_id: model.provider_id,
                        provider_family_id: model.provider_family_id,
                        model_id: model.model_id,
                        reasoning_efforts: model
                            .reasoning_efforts
                            .into_iter()
                            .map(reasoning)
                            .collect(),
                        default_reasoning_effort: reasoning(model.default_reasoning_effort),
                        context_window_tokens: model.context_window_tokens,
                    }
                })
                .collect();
            Ok(AdmissionModelCatalogSnapshot {
                metadata,
                retry_ceiling: Some(retry_attempts(self.environment.retry_attempts.as_deref())),
            })
        })
    }
}

fn reasoning(value: super::super::ReasoningEffort) -> ReasoningEffort {
    use super::super::ReasoningEffort as ModelReasoning;
    match value {
        ModelReasoning::None => ReasoningEffort::None,
        ModelReasoning::Low => ReasoningEffort::Low,
        ModelReasoning::Medium => ReasoningEffort::Medium,
        ModelReasoning::High => ReasoningEffort::High,
        ModelReasoning::Xhigh => ReasoningEffort::Xhigh,
        ModelReasoning::Max => ReasoningEffort::Max,
    }
}

pub(super) fn retry_attempts(value: Option<&str>) -> f64 {
    let Some(value) = value else {
        return 3.0;
    };
    let value = crate::public_text::trim_js_whitespace(value);
    let number = if value.is_empty() {
        0.0
    } else if value.starts_with("0x") || value.starts_with("0X") {
        radix_number(&value[2..], 16)
    } else if value.starts_with("0b") || value.starts_with("0B") {
        radix_number(&value[2..], 2)
    } else if value.starts_with("0o") || value.starts_with("0O") {
        radix_number(&value[2..], 8)
    } else {
        value.parse().unwrap_or(f64::NAN)
    };
    if number.is_finite() {
        number.trunc().clamp(1.0, 5.0)
    } else {
        3.0
    }
}

fn radix_number(value: &str, radix: u32) -> f64 {
    if value.is_empty() {
        return f64::NAN;
    }
    value
        .chars()
        .try_fold(0.0, |number, digit| {
            digit
                .to_digit(radix)
                .map(|digit| number * f64::from(radix) + f64::from(digit))
        })
        .unwrap_or(f64::NAN)
}
