use std::collections::HashSet;

use serde_json::{Map, Number, Value};

use super::{AdmissionModelCatalogSnapshot, AdmissionModelMetadata, js_truthy, object};
use crate::btcc::identity::digest;
use crate::btcc::{BtccError, ReasoningEffort, VerifiedExecutionControls};
use crate::json::stringify;
use crate::public_text::trim_js_whitespace;
use crate::workspace::StoredSessionBinding;

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
) -> Result<Value, BtccError> {
    let refs = requested_refs(binding, controls)?;
    let primary = refs.first().expect("primary model");
    let separator = primary
        .find('/')
        .filter(|value| *value > 0 && *value < primary.len() - 1)
        .ok_or_else(|| {
            BtccError::new(
                "admitted_model_invalid",
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
    let controls_value = Value::Object(admitted_controls);
    let controls_hash = match controls {
        Some(value) => value.integrity_hash.clone(),
        None => digest(&stringify(&controls_value).map_err(json_error)?),
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
    let mut selection = Map::new();
    selection.insert("provider".into(), primary[..separator].into());
    selection.insert("model".into(), primary[separator + 1..].into());
    selection.insert(
        "reasoningEffort".into(),
        serde_json::to_value(reasoning).map_err(json_error)?,
    );
    selection.insert("controls".into(), controls_value);
    selection.insert("controlsHash".into(), controls_hash.into());
    selection.insert("contextWindowTokens".into(), number(context_window)?);
    selection.insert("modelRoute".into(), route);
    Ok(Value::Object(selection))
}

fn build_route(
    refs: &[String],
    reasoning: &ReasoningEffort,
    controls: Option<&VerifiedExecutionControls>,
    catalog: &AdmissionModelCatalogSnapshot,
) -> Result<Value, BtccError> {
    let mut identities = HashSet::new();
    let mut candidates = Vec::new();
    for reference in refs
        .iter()
        .map(|value| trim_js_whitespace(value))
        .filter(|v| !v.is_empty())
    {
        let metadata = metadata(catalog, reference).ok_or_else(|| {
            BtccError::new(
                "model_metadata_missing",
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
        candidates.push(Value::Object(Map::from_iter([
            ("modelRef".into(), reference.into()),
            (
                "reasoningEffort".into(),
                serde_json::to_value(admitted).map_err(json_error)?,
            ),
        ])));
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
    let mut body = Map::new();
    body.insert("schemaVersion".into(), "butler.model-route.v1".into());
    body.insert("candidates".into(), Value::Array(candidates));
    body.insert("retryCeiling".into(), number(retry)?);
    body.insert("catalogGeneration".into(), generation.into());
    let route_digest = digest(&stringify(&Value::Object(body.clone())).map_err(json_error)?);
    body.insert("routeDigest".into(), route_digest.into());
    body.insert("activeCursor".into(), 0.into());
    body.insert("consumedAttempts".into(), Value::Array(Vec::new()));
    Ok(Value::Object(body))
}

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
    match value.as_str() {
        "none" => Ok(ReasoningEffort::None),
        "low" => Ok(ReasoningEffort::Low),
        "medium" => Ok(ReasoningEffort::Medium),
        "high" => Ok(ReasoningEffort::High),
        "xhigh" => Ok(ReasoningEffort::Xhigh),
        "max" => Ok(ReasoningEffort::Max),
        _ => Err(BtccError::new(
            "admitted_reasoning_invalid",
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
        Err(BtccError::new(
            "admitted_model_missing",
            format!("{label} is missing"),
        ))
    } else {
        Ok(value)
    }
}
fn number(value: f64) -> Result<Value, BtccError> {
    Number::from_f64(value)
        .map(Value::Number)
        .ok_or_else(|| BtccError::new("model_number_invalid", "BTCC model number is invalid"))
}
fn json_error(error: impl std::fmt::Display) -> BtccError {
    BtccError::new("btcc_json_error", error.to_string())
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
