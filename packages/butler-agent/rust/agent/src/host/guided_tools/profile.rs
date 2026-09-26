//! Turn-scoped profile tools over the runtime-owned ProfileService.
//! Source classifies onboarding as turn_local and summary as none; an
//! interrupted onboarding write is never replayed from a started journal row.

use serde_json::{Map, Value, json};

use crate::{
    btcc::{AccessMode, ModelRoundToolCall, ToolExecutionError},
    json::JsonDocument,
    profile::{FirstChatOnboardingUpdate, ProfileError, ProfilingMode},
};

use super::NativeGuidedTools;

pub(super) fn supports(name: &str) -> bool {
    matches!(name, "update_onboarding_profile" | "summarize_user_profile")
}

pub(super) async fn execute(
    owner: &NativeGuidedTools,
    call: &ModelRoundToolCall,
) -> Result<JsonDocument, ToolExecutionError> {
    let result = match call.name.as_str() {
        "update_onboarding_profile" => {
            if owner.binding.access_mode != AccessMode::FullAccess {
                return encoded(&json!({"ok":false,"error":{
                    "code":"profile_write_requires_full_access",
                    "message":"This Turn does not have full access; no profile change was applied."
                }}));
            }
            let input = onboarding_input(&call.arguments);
            owner
                .profile
                .update_first_chat_onboarding(input)
                .await
                .and_then(profile_value)
        }
        "summarize_user_profile" => {
            let locale = if text(&call.arguments, "locale") == Some("en") {
                "en"
            } else {
                "ko"
            };
            owner
                .profile
                .reflective_summary(locale)
                .await
                .and_then(profile_value)
        }
        // Dispatch routes only supported names here.
        _ => Err(ProfileError::new(
            "unknown_tool",
            "This tool is not a profile tool.",
        )),
    };
    match result {
        Ok(value) => encoded(&value),
        Err(error) => encoded(&json!({"ok":false,"error":{
            "code":error.code,
            "message":error.message
        }})),
    }
}

fn profile_value(value: impl serde::Serialize) -> Result<Value, ProfileError> {
    serde_json::to_value(value)
        .map_err(|error| ProfileError::new("profile_result_invalid", error.to_string()))
}

fn onboarding_input(args: &Map<String, Value>) -> FirstChatOnboardingUpdate {
    let strings = |key| args.get(key).and_then(Value::as_str).map(str::to_owned);
    FirstChatOnboardingUpdate {
        principal_name: strings("principal_name"),
        preferred_address: strings("preferred_address"),
        butler_nickname: strings("butler_nickname"),
        interests: strings("interests"),
        work: strings("work"),
        service_preference: strings("service_preference"),
        persona_preset: text(args, "persona_preset")
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
        persona_custom: strings("persona_custom"),
        profiling_mode: match text(args, "profiling_mode") {
            Some("off") => Some(ProfilingMode::Off),
            Some("basic") => Some(ProfilingMode::Basic),
            Some("deep") => Some(ProfilingMode::Deep),
            _ => None,
        },
        skipped_fields: args
            .get("skipped_fields")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        complete: args.get("complete").and_then(Value::as_bool) == Some(true),
        locale: Some(
            if text(args, "locale") == Some("en") {
                "en"
            } else {
                "ko"
            }
            .to_owned(),
        ),
    }
}

fn text<'a>(args: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

fn encoded(value: &Value) -> Result<JsonDocument, ToolExecutionError> {
    JsonDocument::from_value(value).map_err(|error| {
        ToolExecutionError::Integrity(crate::btcc::BtccError::relayed(
            "guided_profile_result_json",
            error.to_string(),
        ))
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn onboarding_arguments_keep_source_defaults_and_skip_non_strings() {
        let args = json!({
            "principal_name":"Ari",
            "persona_preset":" custom ",
            "profiling_mode":"unrecognized",
            "skipped_fields":["interests",3,null],
            "complete":true,
            "locale":"unknown"
        });
        let input = onboarding_input(args.as_object().unwrap());
        assert_eq!(input.principal_name.as_deref(), Some("Ari"));
        assert_eq!(input.persona_preset.as_deref(), Some("custom"));
        assert_eq!(input.profiling_mode, None);
        assert_eq!(input.skipped_fields, vec!["interests".to_owned()]);
        assert!(input.complete);
        assert_eq!(input.locale.as_deref(), Some("ko"));
    }
}
