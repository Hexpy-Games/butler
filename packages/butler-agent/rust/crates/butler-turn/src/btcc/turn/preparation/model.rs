use std::collections::HashSet;

use serde_json::{Map, Value};

use super::{AdmissionModelCatalogSnapshot, AdmissionModelMetadata, js_truthy, object};
use crate::btcc::BtccCode;
use crate::btcc::identity::digest;
use crate::btcc::{
    AdmittedModelSelection, BtccError, CommandModelSelection, ReasoningEffort, RouteCandidate,
    RouteIdentity, RouteState, VerifiedExecutionControls,
};
use crate::workspace::StoredSessionBinding;
use butler_core::json::stringify;
use butler_core::public_text::trim_js_whitespace;

pub(super) fn requested_refs(
    binding: &StoredSessionBinding,
    controls: Option<&VerifiedExecutionControls>,
) -> Result<Vec<String>, BtccError> {
    let primary = required_text(
        controls
            .map(|value| value.model_ref.as_str())
            .unwrap_or(&binding.model_ref),
        "BTCC admitted model",
    )?;
    let mut refs = vec![primary.into()];
    if let Some(fallback) = controls.and_then(|value| value.model_fallback.as_ref())
        && fallback.enabled
    {
        refs.extend(fallback.models.clone());
    }
    Ok(refs)
}

pub(super) fn catalog_refs(refs: &[String]) -> Vec<String> {
    refs.iter()
        .map(|value| trim_js_whitespace(value).to_owned())
        .filter(|value| !value.is_empty())
        .collect()
}

pub(super) fn admit(
    binding: &StoredSessionBinding,
    controls: Option<&VerifiedExecutionControls>,
    catalog: &AdmissionModelCatalogSnapshot,
) -> Result<CommandModelSelection, BtccError> {
    let refs = requested_refs(binding, controls)?;
    let Some(primary) = refs.first() else {
        return Err(BtccError::detected(
            BtccCode::AdmittedModelInvalid,
            "BTCC admitted model is missing",
        ));
    };
    let separator = primary
        .find('/')
        .filter(|value| *value > 0 && *value < primary.len() - 1)
        .ok_or_else(|| {
            BtccError::detected(
                BtccCode::AdmittedModelInvalid,
                format!("BTCC admitted model is not canonical: {primary}"),
            )
        })?;
    let reasoning = match controls {
        Some(value) => value.reasoning_effort.clone(),
        None => binding_reasoning(binding)?,
    };
    let mut admitted_controls = Map::new();
    if let Some(controls) = controls {
        admitted_controls.insert(
            "accessMode".into(),
            serde_json::to_value(&controls.access_mode).map_err(json_error)?,
        );
        admitted_controls.insert("planMode".into(), controls.plan_mode.into());
        admitted_controls.insert(
            "source".into(),
            serde_json::to_value(&controls.source).map_err(json_error)?,
        );
        admitted_controls.insert(
            "sessionControlRevision".into(),
            controls.session_control_revision.into(),
        );
        admitted_controls.insert(
            "catalogGeneration".into(),
            controls.catalog_generation.clone().into(),
        );
    } else {
        admitted_controls.insert("accessMode".into(), binding_access_mode(binding).into());
        let plan = binding
            .metadata
            .as_ref()
            .and_then(|v| v.get("plan_mode"))
            .is_some_and(js_truthy);
        admitted_controls.insert("planMode".into(), plan.into());
        admitted_controls.insert("source".into(), "stored_session_binding".into());
    }
    let controls_hash = match controls {
        Some(value) => value.integrity_hash.clone(),
        None => digest(&stringify(&Value::Object(admitted_controls.clone())).map_err(json_error)?),
    };
    let route = build_route(&refs, &reasoning, controls, catalog)?;
    let configured = binding
        .metadata
        .as_ref()
        .and_then(|v| v.get("context_window_tokens"))
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite() && *v > 0.0)
        .map(f64::trunc);
    let context_window = configured
        .or_else(|| {
            metadata(catalog, trim_js_whitespace(primary))
                .and_then(|value| value.context_window_tokens)
        })
        .unwrap_or(200_000.0);
    if !context_window.is_finite() {
        return Err(number_error());
    }
    let (provider, model) = primary.split_at(separator);
    Ok(CommandModelSelection {
        selection: AdmittedModelSelection {
            provider: provider.into(),
            model: model.get(1..).unwrap_or_default().into(),
            reasoning_effort: reasoning,
            controls: admitted_controls,
            controls_hash,
            context_window_tokens: Some(context_window),
            extensions: Map::new(),
        },
        model_route: Some(route),
    })
}

fn build_route(
    refs: &[String],
    reasoning: &ReasoningEffort,
    controls: Option<&VerifiedExecutionControls>,
    catalog: &AdmissionModelCatalogSnapshot,
) -> Result<RouteState, BtccError> {
    let mut identities = HashSet::new();
    let mut candidates = Vec::new();
    for reference in refs
        .iter()
        .map(|value| trim_js_whitespace(value))
        .filter(|v| !v.is_empty())
    {
        let metadata = metadata(catalog, reference).ok_or_else(|| {
            BtccError::detected(
                BtccCode::ModelMetadataMissing,
                format!("Model metadata is missing: {reference}"),
            )
        })?;
        let family = metadata
            .provider_family_id
            .as_deref()
            .map(trim_js_whitespace)
            .filter(|v| !v.is_empty())
            .unwrap_or(&metadata.provider_id);
        if !identities.insert(format!("{family}:{}", metadata.model_id)) {
            continue;
        }
        let admitted = if metadata.reasoning_efforts.contains(reasoning) {
            reasoning
        } else {
            &metadata.default_reasoning_effort
        };
        candidates.push(RouteCandidate {
            model_ref: reference.into(),
            reasoning_effort: admitted.clone(),
        });
        if candidates.len() == 6 {
            break;
        }
    }
    let retry = catalog
        .retry_ceiling
        .filter(|v| v.is_finite())
        .unwrap_or(3.0)
        .trunc()
        .clamp(1.0, 5.0);
    let generation = controls
        .map(|v| trim_js_whitespace(&v.catalog_generation))
        .filter(|v| !v.is_empty())
        .unwrap_or("unknown");
    // `retry` is a whole number clamped to 1..=5.
    let retry_ceiling = butler_core::json::saturating_u32(retry);
    let identity = RouteIdentity {
        schema_version: ROUTE_SCHEMA,
        candidates: &candidates,
        retry_ceiling,
        catalog_generation: generation,
    };
    let identity = serde_json::to_value(identity).map_err(json_error)?;
    let route_digest = digest(&stringify(&identity).map_err(json_error)?);
    Ok(RouteState {
        schema_version: ROUTE_SCHEMA.into(),
        candidates,
        retry_ceiling,
        catalog_generation: generation.into(),
        route_digest,
        active_cursor: 0,
        consumed_attempts: Vec::new(),
    })
}

const ROUTE_SCHEMA: &str = "butler.model-route.v1";

fn metadata<'a>(
    catalog: &'a AdmissionModelCatalogSnapshot,
    reference: &str,
) -> Option<&'a AdmissionModelMetadata> {
    catalog
        .metadata
        .iter()
        .find(|value| value.requested_model_ref == reference)
}
fn binding_reasoning(binding: &StoredSessionBinding) -> Result<ReasoningEffort, BtccError> {
    let value = binding
        .metadata
        .as_ref()
        .and_then(|v| v.get("reasoning_effort"))
        .filter(|value| !value.is_null())
        .map(|v| match v {
            Value::String(v) => v.clone(),
            _ => js_string(v),
        })
        .unwrap_or_else(|| "medium".into());
    reasoning(&value)
}

/// The reasoning effort of a stored binding value.
fn reasoning(value: &str) -> Result<ReasoningEffort, BtccError> {
    match value {
        "none" => Ok(ReasoningEffort::None),
        "low" => Ok(ReasoningEffort::Low),
        "medium" => Ok(ReasoningEffort::Medium),
        "high" => Ok(ReasoningEffort::High),
        "xhigh" => Ok(ReasoningEffort::Xhigh),
        "max" => Ok(ReasoningEffort::Max),
        _ => Err(BtccError::detected(
            BtccCode::AdmittedReasoningInvalid,
            format!("BTCC admitted reasoning effort is invalid: {value}"),
        )),
    }
}
fn binding_access_mode(binding: &StoredSessionBinding) -> &'static str {
    let metadata = binding.metadata.as_ref();
    let runtime = object(metadata.and_then(|v| v.get("runtimePolicy")));
    match runtime
        .get("accessMode")
        .filter(|value| !value.is_null())
        .or_else(|| metadata.and_then(|v| v.get("accessMode")))
        .and_then(Value::as_str)
    {
        Some("full_access") => "full_access",
        Some("ask_first") => "ask_first",
        _ => "read_only",
    }
}
fn required_text<'a>(value: &'a str, label: &str) -> Result<&'a str, BtccError> {
    if trim_js_whitespace(value).is_empty() {
        Err(BtccError::detected(
            BtccCode::AdmittedModelMissing,
            format!("{label} is missing"),
        ))
    } else {
        Ok(value)
    }
}
fn number_error() -> BtccError {
    BtccError::detected(BtccCode::ModelNumberInvalid, "BTCC model number is invalid")
}
fn json_error(error: impl std::error::Error + Send + Sync + 'static) -> BtccError {
    BtccError::detected(BtccCode::BtccJsonError, error.to_string()).with_source(error)
}
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.clone(),
        Value::Array(values) => values
            .iter()
            .map(|value| match value {
                Value::Null => String::new(),
                _ => js_string(value),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}
