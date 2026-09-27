use serde_json::Value;

const UPDATE_KEYS: &[&str] = &[
    "server_url",
    "language",
    "timezone",
    "model",
    "reasoning_effort",
    "consolidation_model",
    "consolidation_reasoning_effort",
    "context_window_tokens",
    "worker_profiles",
    "max_simultaneous_workers",
    "access_mode",
    "plan_mode_default",
    "follow_up_behavior",
    "multiline_send_behavior",
    "appearance_theme",
    "main_screen_theme",
    "main_screen_theme_preset",
    "main_screen_theme_custom_colors",
    "translucent_sidebar",
    "diagnostics_enabled",
    "desktop_notifications",
    "desktop_tray_enabled",
    "web_search",
    "model_fallback",
    "default_project_folder_selection_token",
];

pub(super) fn is_request(value: &Value) -> bool {
    let Some(input) = value.as_object() else {
        return false;
    };
    if !input.keys().all(|key| UPDATE_KEYS.contains(&key.as_str())) {
        return false;
    }
    if input.get("context_window_tokens").is_some_and(|value| {
        !value
            .as_f64()
            .is_some_and(|number| number.is_finite() && number > 0.0)
    }) || input
        .get("language")
        .is_some_and(|value| !matches!(value.as_str(), Some("en" | "ko")))
        || input
            .get("timezone")
            .is_some_and(|value| !is_iana_timezone(value))
        || input
            .get("consolidation_model")
            .is_some_and(|value| !value.is_string())
        || input
            .get("consolidation_reasoning_effort")
            .is_some_and(|value| !is_reasoning(value))
        || input
            .get("worker_profiles")
            .is_some_and(|value| !is_worker_profiles(value))
        || input.get("max_simultaneous_workers").is_some_and(|value| {
            !value.as_f64().is_some_and(|count| {
                count.is_finite() && count.fract() == 0.0 && (1.0..=10.0).contains(&count)
            })
        })
        || input
            .get("desktop_notifications")
            .is_some_and(|value| !is_notifications(value))
        || input
            .get("desktop_tray_enabled")
            .is_some_and(|value| !value.is_boolean())
        || input
            .get("web_search")
            .is_some_and(|value| !is_web_search(value))
        || input
            .get("model_fallback")
            .is_some_and(|value| !is_model_fallback(value))
    {
        return false;
    }
    true
}

pub(super) fn is_iana_timezone(value: &Value) -> bool {
    let Some(value) = value.as_str() else {
        return false;
    };
    let zone = value.trim();
    if zone.is_empty()
        || utf16_len(zone) > 96
        || zone.starts_with('/')
        || zone.split('/').any(|part| matches!(part, "" | "." | ".."))
    {
        return false;
    }
    ["/usr/share/zoneinfo", "/var/db/timezone/zoneinfo"]
        .iter()
        .any(|root| {
            let Ok(bytes) = std::fs::read(std::path::Path::new(root).join(zone)) else {
                return false;
            };
            tz::TimeZone::from_tz_data(&bytes).is_ok()
        })
}

fn is_reasoning(value: &Value) -> bool {
    matches!(
        value.as_str(),
        Some("none" | "low" | "medium" | "high" | "xhigh" | "max")
    )
}

fn is_model_fallback(value: &Value) -> bool {
    let Some(input) = value.as_object() else {
        return false;
    };
    input
        .keys()
        .all(|key| matches!(key.as_str(), "enabled" | "models"))
        && input.get("enabled").is_none_or(Value::is_boolean)
        && input.get("models").is_none_or(|models| {
            models
                .as_array()
                .is_some_and(|models| models.iter().all(Value::is_string))
        })
}

fn is_notifications(value: &Value) -> bool {
    let Some(input) = value.as_object() else {
        return false;
    };
    input.iter().all(|(key, value)| {
        matches!(
            key.as_str(),
            "enabled" | "assistant_messages" | "task_completions"
        ) && value.is_boolean()
    })
}

fn is_web_search(value: &Value) -> bool {
    let Some(input) = value.as_object() else {
        return false;
    };
    input.iter().all(|(key, value)| match key.as_str() {
        "provider" => matches!(
            value.as_str(),
            Some(
                "duckduckgo-html"
                    | "auto"
                    | "brave"
                    | "tavily"
                    | "openai-web-search"
                    | "codex-subscription-web-search"
                    | "disabled"
            )
        ),
        "reader_backend" => matches!(
            value.as_str(),
            Some("lightweight" | "auto" | "lightpanda" | "jina-hosted" | "disabled")
        ),
        "api_key" => value.is_string(),
        "planning_enabled" => value.is_boolean(),
        "planning_default_depth" => {
            matches!(value.as_str(), Some("quick" | "balanced" | "deep"))
        }
        _ => false,
    })
}

fn is_worker_profiles(value: &Value) -> bool {
    let Some(profiles) = value
        .as_array()
        .filter(|profiles| (1..=12).contains(&profiles.len()))
    else {
        return false;
    };
    let mut ids = std::collections::HashSet::new();
    profiles.iter().all(|profile| {
        let Some(profile) = profile.as_object() else {
            return false;
        };
        if !profile.keys().all(|key| {
            matches!(
                key.as_str(),
                "id" | "label"
                    | "enabled"
                    | "job"
                    | "domain"
                    | "model"
                    | "reasoning_effort"
                    | "prompt"
            )
        }) {
            return false;
        }
        let Some(id) = profile.get("id").and_then(Value::as_str) else {
            return false;
        };
        if !(id == "default" || numbered_profile_id(id)) || !ids.insert(id.to_ascii_lowercase()) {
            return false;
        }
        if !profile
            .get("label")
            .and_then(Value::as_str)
            .is_some_and(|value| bounded_text(value, 64))
            || !profile.get("enabled").is_some_and(Value::is_boolean)
            || !profile
                .get("model")
                .and_then(Value::as_str)
                .is_some_and(bounded_model_ref)
            || !profile.get("reasoning_effort").is_some_and(is_reasoning)
            || profile
                .get("domain")
                .is_some_and(|value| value.as_str().is_none_or(|value| !bounded_text(value, 96)))
            || profile
                .get("prompt")
                .is_some_and(|value| value.as_str().is_none_or(|value| utf16_len(value) > 2000))
            || !profile.get("job").is_some_and(is_worker_job)
        {
            return false;
        }
        true
    })
}

fn numbered_profile_id(value: &str) -> bool {
    let Some(number) = value.strip_prefix('w') else {
        return false;
    };
    !number.is_empty()
        && matches!(number.as_bytes()[0], b'1'..=b'9')
        && number.bytes().all(|byte| byte.is_ascii_digit())
}

fn is_worker_job(value: &Value) -> bool {
    let Some(job) = value.as_object() else {
        return false;
    };
    match job.get("kind").and_then(Value::as_str) {
        Some("builtin") => {
            job.len() == 2
                && matches!(
                    job.get("job").and_then(Value::as_str),
                    Some("coding" | "research" | "debug" | "review" | "writing")
                )
        }
        Some("custom") => {
            job.len() == 2
                && job
                    .get("text")
                    .and_then(Value::as_str)
                    .is_some_and(|value| bounded_text(value, 160))
        }
        _ => false,
    }
}

fn bounded_model_ref(value: &str) -> bool {
    !value.trim().is_empty()
        && utf16_len(value.trim()) <= 128
        && !value.chars().any(char::is_whitespace)
}

fn bounded_text(value: &str, limit: usize) -> bool {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    !collapsed.is_empty() && utf16_len(&collapsed) <= limit
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}
