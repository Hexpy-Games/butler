//! Persisted composer art preferences; the DS owns scene geometry and tuning.
use crate::gateway::GatewayApplicationError;
use serde::Deserialize;
use serde_json::{Value, json};

pub(super) const KEY: &str = "composer_decoration";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Patch {
    theme: Option<Theme>,
    character: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Theme {
    None,
    Shoreline,
    Cherry,
}

pub(super) fn sanitize(value: &Value) -> Result<Value, GatewayApplicationError> {
    let checked = serde_json::from_value::<Patch>(value.clone());
    match checked {
        Ok(patch)
            if (patch.theme.is_some() || patch.character.is_some())
                && value
                    .as_object()
                    .is_some_and(|fields| fields.values().all(|value| !value.is_null())) =>
        {
            Ok(value.clone())
        }
        _ => Err(GatewayApplicationError::Public {
            status: 400,
            code: "settings_composer_decoration_invalid".into(),
            message:
                "Composer decoration requires theme (none, shoreline or cherry) or character (boolean)."
                    .into(),
            source: None,
        }),
    }
}

pub(super) fn view(stored: Option<&Value>) -> Value {
    let mut result = json!({"theme":"none", "character":true});
    if let Some(stored) = stored
        .filter(|value| sanitize(value).is_ok())
        .and_then(Value::as_object)
        && let Some(result) = result.as_object_mut()
    {
        result.extend(stored.clone());
    }
    result
}

pub(super) fn project(current: &Value, patch: &Value, output: &mut Value) {
    let mut setting = view(current.get(KEY));
    if let Some(patch) = patch.get(KEY).and_then(Value::as_object)
        && let Some(setting) = setting.as_object_mut()
    {
        setting.extend(patch.clone());
    }
    output[KEY] = setting;
}

/// A decoration-only PATCH with no effective change has no side effects.
pub(super) fn unchanged(patch: &Value, current: &Value) -> bool {
    patch.as_object().is_some_and(|fields| {
        fields.len() == 1
            && fields
                .get(KEY)
                .and_then(Value::as_object)
                .is_some_and(|changes| {
                    let setting = view(current.get(KEY));
                    changes
                        .iter()
                        .all(|(key, value)| setting.get(key) == Some(value))
                })
    })
}
