//! Generic operator configuration parsing and validation for the native CLI.

use serde_json::{Number, Value};

use crate::models::{ParsedModelRefSource, parse_model_ref};

pub(super) const SAFE_CONFIG_PATHS: &[&str] = &[
    "user.language",
    "user.techLanguage",
    "user.timezone",
    "system.defaultModel",
    "system.butlerModel",
    "system.workerModel",
    "system.openaiModel",
    "system.openaiReasoningEffort",
    "system.openaiPromptCacheKeyPrefix",
    "system.openaiPromptCacheRetention",
    "personalization.profiling.extractorModel",
    "webSearch.provider",
    "webSearch.readerBackend",
    "webSearch.model",
    "webSearch.apiBase",
    "webSearch.braveApiBase",
    "webSearch.tavilyApiBase",
    "webSearch.planning.enabled",
    "webSearch.planning.defaultDepth",
    "metrics.enabled",
    "metrics.retentionDays",
];

const WEB_SEARCH_PROVIDERS: &[&str] = &[
    "duckduckgo-html",
    "duckduckgo",
    "brave",
    "tavily",
    "openai-web-search",
    "codex-subscription-web-search",
    "auto",
    "mock",
    "disabled",
];
const READER_BACKENDS: &[&str] = &[
    "auto",
    "lightpanda",
    "lightweight",
    "jina-hosted",
    "disabled",
];
const PLANNING_DEPTHS: &[&str] = &["quick", "balanced", "deep"];

pub(super) struct Validation {
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

pub(super) fn is_secret_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    [
        "token",
        "secret",
        "password",
        "credential",
        "authorization",
        "refresh",
    ]
    .iter()
    .any(|part| lower.contains(part))
        || ["apikey", "api_key", "api-key"]
            .iter()
            .any(|part| lower.contains(part))
}

pub(super) fn value_at_path<'a>(config: &'a Value, dotted_path: &str) -> Option<&'a Value> {
    if dotted_path.is_empty() {
        return None;
    }
    dotted_path.split('.').try_fold(config, |current, part| {
        if let Some(object) = current.as_object() {
            object.get(part)
        } else if let Some(array) = current.as_array() {
            part.parse::<usize>()
                .ok()
                .and_then(|index| array.get(index))
        } else {
            None
        }
    })
}

pub(super) fn set_path(config: &mut Value, dotted_path: &str, value: Value) {
    let mut parts = dotted_path.split('.').peekable();
    let Some(mut current) = config.as_object_mut() else {
        return;
    };
    while let Some(part) = parts.next() {
        if parts.peek().is_none() {
            current.insert(part.to_owned(), value);
            return;
        }
        current = crate::json::object_field_mut(current, part);
    }
}

pub(super) fn parse_value(raw: &str) -> Value {
    let trimmed = crate::public_text::trim_js_whitespace(raw);
    match trimmed {
        "true" => return Value::Bool(true),
        "false" => return Value::Bool(false),
        _ => {}
    }
    if is_number(trimmed) {
        let value = trimmed.parse::<f64>().unwrap_or(f64::INFINITY);
        return Number::from_f64(value).map_or(Value::Null, Value::Number);
    }
    Value::String(raw.to_owned())
}

pub(super) fn safe_value(value: Option<&Value>) -> Value {
    match value {
        Some(Value::String(text)) if text.chars().count() > 160 => {
            let shortened = text.chars().take(157).collect::<String>();
            Value::String(format!("{shortened}..."))
        }
        Some(Value::Array(values)) => {
            Value::Array(values.iter().map(|value| safe_value(Some(value))).collect())
        }
        Some(Value::Object(values)) => Value::Object(
            values
                .iter()
                .map(|(key, value)| {
                    let safe = if is_secret_path(key) {
                        Value::String("[redacted]".into())
                    } else {
                        safe_value(Some(value))
                    };
                    (key.clone(), safe)
                })
                .collect(),
        ),
        Some(value) => value.clone(),
        None => Value::Null,
    }
}

pub(super) fn human_value(value: Option<&Value>) -> String {
    match value {
        None => "(missing)".into(),
        Some(Value::String(value)) => value.clone(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(value)) => value.to_string(),
        Some(Value::Number(value)) => value.to_string(),
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| match value {
                Value::Null => String::new(),
                Value::String(value) => value.clone(),
                other => other.to_string(),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

pub(super) fn validate(config: &Value) -> Validation {
    let mut result = Validation {
        errors: Vec::new(),
        warnings: Vec::new(),
    };
    let system = config.get("system");
    if let Some(runtime) = system.and_then(|value| value.get("runtime"))
        && runtime != "codex-api"
    {
        result
            .errors
            .push("system.runtime must be codex-api".into());
    }
    let web_search = config.get("webSearch");
    if let Some(provider) = web_search.and_then(|value| value.get("provider"))
        && !WEB_SEARCH_PROVIDERS.contains(&js_string(provider).as_str())
    {
        result
            .errors
            .push("webSearch.provider is not supported".into());
    }
    if let Some(reader) = web_search.and_then(|value| value.get("readerBackend"))
        && !READER_BACKENDS.contains(&js_string(reader).as_str())
    {
        result
            .errors
            .push("webSearch.readerBackend is not supported".into());
    }
    if let Some(planning) = web_search.and_then(|value| value.get("planning")) {
        let Some(planning) = planning.as_object() else {
            result
                .errors
                .push("webSearch.planning must be an object".into());
            return validate_remaining(config, result);
        };
        if planning
            .get("enabled")
            .is_some_and(|value| !value.is_boolean())
        {
            result
                .errors
                .push("webSearch.planning.enabled must be boolean".into());
        }
        if planning.contains_key("mode") {
            result.warnings.push(
                "webSearch.planning.mode is deprecated; use webSearch.planning.enabled".into(),
            );
        }
        if planning
            .get("defaultDepth")
            .is_some_and(|value| !PLANNING_DEPTHS.contains(&js_string(value).as_str()))
        {
            result
                .errors
                .push("webSearch.planning.defaultDepth is not supported".into());
        }
    }
    validate_remaining(config, result)
}

fn validate_remaining(config: &Value, mut result: Validation) -> Validation {
    let system = config.get("system");
    let model = ["defaultModel", "butlerModel", "workerModel"]
        .into_iter()
        .filter_map(|key| system.and_then(|value| value.get(key)))
        .find(|value| !value.is_null());
    if let Some(model) = model {
        let parsed = parse_model_ref(&js_string(model));
        if parsed.model_id.is_empty() {
            result
                .errors
                .push("system model ref must include a model id".into());
        }
        if parsed.source != ParsedModelRefSource::Namespaced {
            result
                .warnings
                .push("system model ref will be canonicalized to provider/model form".into());
        }
    }
    let extractor = config.pointer("/personalization/profiling/extractorModel");
    if let Some(extractor) = extractor
        && js_string(extractor).trim() != "default"
    {
        let parsed = parse_model_ref(&js_string(extractor));
        if parsed.model_id.is_empty() {
            result.errors.push(
                "personalization.profiling.extractorModel must include a model id or be default"
                    .into(),
            );
        }
        if parsed.source != ParsedModelRefSource::Namespaced {
            result.warnings.push(
                "personalization.profiling.extractorModel will be canonicalized to provider/model form"
                    .into(),
            );
        }
    }
    if config
        .pointer("/metrics/enabled")
        .is_some_and(|value| !value.is_boolean())
    {
        result.errors.push("metrics.enabled must be boolean".into());
    }
    result
}

fn is_number(value: &str) -> bool {
    let digits = value.strip_prefix('-').unwrap_or(value);
    let Some((whole, fraction)) = digits.split_once('.') else {
        return !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit());
    };
    !whole.is_empty()
        && !fraction.is_empty()
        && whole.bytes().all(|byte| byte.is_ascii_digit())
        && fraction.bytes().all(|byte| byte.is_ascii_digit())
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
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}
