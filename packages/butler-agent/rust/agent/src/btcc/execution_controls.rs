//! Signed admission controls retain their original JSON property order.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::identity::{digest, json_stringify_without};
use super::{AccessMode, BtccError, ReasoningEffort};
use crate::btcc::BtccCode;

const SCHEMA: &str = "butler.turn-execution-controls.v1";
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct ExecutionControls(Value);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ControlSource {
    MessageOverride,
    SessionOverride,
    GlobalDefault,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ModelFallback {
    pub(crate) enabled: bool,
    pub(crate) models: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct SubsessionResultContext {
    pub(crate) relation_id: String,
    pub(crate) result_id: String,
    pub(crate) safe_title: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct VerifiedExecutionControls {
    pub(crate) turn_id: String,
    pub(crate) session_id: String,
    pub(crate) model_ref: String,
    pub(crate) reasoning_effort: ReasoningEffort,
    pub(crate) access_mode: AccessMode,
    pub(crate) plan_mode: bool,
    pub(crate) source: ControlSource,
    pub(crate) session_control_revision: u64,
    pub(crate) catalog_generation: String,
    pub(crate) resolved_at: String,
    pub(crate) integrity_hash: String,
    pub(crate) model_fallback: Option<ModelFallback>,
    pub(crate) subsession_result: Option<SubsessionResultContext>,
}

/// Inputs covered by the integrity hash. App-only authority and Plan bindings
/// remain with the caller and must not be inserted into the signed body.
pub(crate) struct ControlResolution {
    pub(crate) model: String,
    pub(crate) reasoning_effort: ReasoningEffort,
    pub(crate) access_mode: AccessMode,
    pub(crate) plan_mode: bool,
    pub(crate) source: ControlSource,
    pub(crate) session_control_revision: u64,
    pub(crate) catalog_generation: String,
    pub(crate) model_fallback: Option<ModelFallback>,
    pub(crate) subsession_result: Option<SubsessionResultContext>,
}

impl ExecutionControls {
    pub(crate) fn create(
        turn_id: &str,
        session_id: &str,
        resolution: ControlResolution,
        resolved_at: &str,
    ) -> Result<Self, BtccError> {
        let mut fields = Map::new();
        fields.insert("schema_version".into(), SCHEMA.into());
        fields.insert("turn_id".into(), turn_id.into());
        fields.insert("session_id".into(), session_id.into());
        fields.insert("model_ref".into(), resolution.model.into());
        fields.insert(
            "reasoning_effort".into(),
            json(&resolution.reasoning_effort)?,
        );
        fields.insert("access_mode".into(), json(&resolution.access_mode)?);
        fields.insert("plan_mode".into(), resolution.plan_mode.into());
        fields.insert("source".into(), json(&resolution.source)?);
        fields.insert(
            "session_control_revision".into(),
            resolution.session_control_revision.into(),
        );
        fields.insert(
            "catalog_generation".into(),
            resolution.catalog_generation.into(),
        );
        fields.insert("resolved_at".into(), resolved_at.into());
        let fallback = resolution.model_fallback.unwrap_or(ModelFallback {
            enabled: false,
            models: Vec::new(),
        });
        fields.insert("model_fallback".into(), json(&fallback)?);
        if let Some(context) = resolution.subsession_result {
            fields.insert("subsession_result".into(), json(&context.normalized()?)?);
        }
        let unsigned = Value::Object(fields);
        let hash = digest(&json_stringify_without(&unsigned, "integrity_hash")?);
        let Value::Object(mut fields) = unsigned else {
            return Err(invalid());
        };
        fields.insert("integrity_hash".into(), hash.into());
        Ok(Self(Value::Object(fields)))
    }

    pub(crate) fn verify(&self) -> Result<VerifiedExecutionControls, BtccError> {
        let fields = self.0.as_object().ok_or_else(invalid)?;
        if fields.get("schema_version").and_then(Value::as_str) != Some(SCHEMA) {
            return Err(invalid());
        }
        let model_ref = text(fields, "model_ref")?;
        if !model_ref.contains('/') {
            return Err(invalid());
        }
        let revision = fields
            .get("session_control_revision")
            .and_then(Value::as_f64)
            .ok_or_else(invalid)?;
        if !revision.is_finite()
            || revision < 0.0
            || revision.fract() != 0.0
            || revision > MAX_SAFE_INTEGER as f64
        {
            return Err(invalid());
        }
        let model_fallback: Option<ModelFallback> = optional(fields, "model_fallback")?;
        if model_fallback.as_ref().is_some_and(|fallback| {
            fallback
                .models
                .iter()
                .any(|model| trim(model).is_empty() || !model.contains('/'))
        }) {
            return Err(invalid());
        }
        let subsession_result: Option<SubsessionResultContext> =
            optional(fields, "subsession_result")?;
        if subsession_result
            .as_ref()
            .is_some_and(|context| !context.valid())
        {
            return Err(invalid());
        }
        let verified = VerifiedExecutionControls {
            turn_id: text(fields, "turn_id")?,
            session_id: text(fields, "session_id")?,
            model_ref,
            reasoning_effort: required(fields, "reasoning_effort")?,
            access_mode: required(fields, "access_mode")?,
            plan_mode: required(fields, "plan_mode")?,
            source: required(fields, "source")?,
            session_control_revision: crate::json::saturating_u64(revision),
            catalog_generation: text(fields, "catalog_generation")?,
            resolved_at: text(fields, "resolved_at")?,
            integrity_hash: text(fields, "integrity_hash")?,
            model_fallback,
            subsession_result,
        };
        let expected = digest(&json_stringify_without(&self.0, "integrity_hash")?);
        if expected != verified.integrity_hash {
            return Err(BtccError::detected(
                BtccCode::TurnExecutionControlsIntegrityMismatch,
                "turn_execution_controls_integrity_mismatch",
            ));
        }
        Ok(verified)
    }

    pub(crate) fn as_json(&self) -> &Value {
        &self.0
    }
}

impl SubsessionResultContext {
    fn valid(&self) -> bool {
        [&self.relation_id, &self.result_id, &self.safe_title]
            .iter()
            .all(|value| !trim(value).is_empty() && value.encode_utf16().count() <= 160)
            && !self
                .safe_title
                .chars()
                .any(|character| character < ' ' || character == '\u{7f}')
    }

    fn normalized(&self) -> Result<Self, BtccError> {
        if !self.valid() {
            return Err(BtccError::detected(
                BtccCode::SubsessionResultTurnContextInvalid,
                "subsession_result_turn_context_invalid",
            ));
        }
        Ok(Self {
            relation_id: trim(&self.relation_id).into(),
            result_id: trim(&self.result_id).into(),
            safe_title: self
                .safe_title
                .split(js_space)
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(" "),
        })
    }
}

fn json(value: &impl Serialize) -> Result<Value, BtccError> {
    serde_json::to_value(value).map_err(|source| invalid().with_source(source))
}

fn required<T: serde::de::DeserializeOwned>(
    fields: &Map<String, Value>,
    key: &str,
) -> Result<T, BtccError> {
    serde_json::from_value(fields.get(key).ok_or_else(invalid)?.clone())
        .map_err(|source| invalid().with_source(source))
}

fn optional<T: serde::de::DeserializeOwned>(
    fields: &Map<String, Value>,
    key: &str,
) -> Result<Option<T>, BtccError> {
    if fields.contains_key(key) {
        required::<T>(fields, key).map(Some)
    } else {
        Ok(None)
    }
}

fn text(fields: &Map<String, Value>, key: &str) -> Result<String, BtccError> {
    let value = fields
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    if trim(value).is_empty() {
        return Err(invalid());
    }
    Ok(value.into())
}

fn trim(value: &str) -> &str {
    value.trim_matches(js_space)
}

fn js_space(character: char) -> bool {
    matches!(character, '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
        '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn invalid() -> BtccError {
    BtccError::detected(
        BtccCode::TurnExecutionControlsInvalid,
        "turn_execution_controls_invalid",
    )
}

#[cfg(test)]
mod tests;
