//! Independent conversation source and paper overlay; photos share the home library.
use super::wallpaper;
use crate::gateway::GatewayApplicationError;
use serde_json::{Value, json};

pub(super) const KEY: &str = "conversation_background";

pub(super) fn invalid(rule: impl Into<String>) -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: 400,
        code: "settings_conversation_background_invalid".into(),
        message: format!("Invalid conversation background: {}.", rule.into()),
        source: None,
    }
}

pub(super) fn sanitize(value: &Value) -> Result<Value, GatewayApplicationError> {
    let fields = value
        .as_object()
        .filter(|fields| !fields.is_empty())
        .ok_or_else(|| invalid("requires source or overlay"))?;
    for (key, value) in fields {
        match key.as_str() {
            "source" => wallpaper::check_agent_source(value)
                .map_err(|(path, rule)| invalid(format!("{KEY}.{path} {rule}")))?,
            "overlay"
                if value
                    .as_u64()
                    .is_some_and(|n| n <= 95 && n.is_multiple_of(5)) => {}
            "overlay" => {
                return Err(invalid(
                    "overlay must be an integer from 0 to 95 in steps of 5",
                ));
            }
            _ => return Err(invalid(format!("{key} is not supported"))),
        }
    }
    Ok(value.clone())
}

pub(super) fn view(stored: Option<&Value>) -> Value {
    let mut setting = json!({"source":wallpaper::default_source(), "overlay":70});
    if let Some(stored) = stored
        .filter(|value| sanitize(value).is_ok())
        .and_then(Value::as_object)
        && let Some(setting) = setting.as_object_mut()
    {
        setting.extend(stored.clone());
    }
    setting
}

pub(super) fn project(current: &Value, patch: &Value, output: &mut Value) {
    let mut setting = view(current.get(KEY));
    if let Some(update) = patch.get(KEY).and_then(Value::as_object)
        && let Some(setting) = setting.as_object_mut()
    {
        setting.extend(update.clone());
    }
    output[KEY] = setting;
}

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
