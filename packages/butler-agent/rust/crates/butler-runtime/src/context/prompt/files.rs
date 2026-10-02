use std::path::{Path, PathBuf};

use butler_turn::workspace::StoredSessionBinding;
use serde_json::{Map, Value};

use crate::context::{ContextError, ContextResult, prefix_utf16};

use super::PromptPaths;
use crate::context::ContextCode;

pub(super) fn resource_path(paths: &PromptPaths, parts: &[&str]) -> PathBuf {
    join(&paths.resource_root, parts)
}

pub(super) fn read_text_if_exists(path: &Path) -> ContextResult<Option<String>> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(path).map_err(|error| {
        ContextError::new(
            ContextCode::PromptFileReadError,
            format!("Failed to read prompt file {}: {error}", path.display()),
        )
        .with_source(error)
    })?;
    let text = String::from_utf8_lossy(&bytes);
    let text = butler_core::public_text::trim_js_whitespace(&text);
    Ok((!text.is_empty()).then(|| text.to_owned()))
}

pub(super) fn read_config(data_root: &Path) -> ContextResult<Value> {
    let Some(text) = read_text_if_exists(&data_root.join("butler.config.json"))? else {
        return Ok(Value::Object(Map::new()));
    };
    Ok(serde_json::from_str(&text).unwrap_or_else(|_| Value::Object(Map::new())))
}

pub(super) async fn build_rules_section(
    rules_dir: &Path,
    binding: &StoredSessionBinding,
    cognition: &dyn super::CognitionPromptPort,
) -> ContextResult<Option<butler_turn::btcc::ContextSection>> {
    let projection = super::PromptProjectionInput {
        session_id: &binding.session_id,
        project_id: binding.project_id.as_deref(),
    };
    let rules = cognition.remembered_rules(&projection, rules_dir).await?;
    if rules.is_empty() {
        return Ok(None);
    }
    let content = rules
        .iter()
        .map(|rule| {
            format!(
                "### [{}] · {}\n\n{}",
                rule.handle,
                if rule.project_id.is_some() {
                    "This project"
                } else {
                    "All chats"
                },
                rule.text
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n---\n\n");
    let targets = rules.iter().map(|rule| serde_json::json!({
        "handle":rule.handle, "expected_revision":rule.revision, "project_id":rule.project_id,
    })).collect::<Vec<_>>();
    let mut section = super::runtime::section(
        "rules",
        "Active Rules",
        content,
        "live_configuration",
        "mandatory_hot_cache",
        "user",
    );
    section.source = Some(serde_json::json!({"rememberedRuleSnapshot":targets}));
    Ok(Some(section))
}

pub(super) fn active_persona(data_root: &Path) -> ContextResult<Option<String>> {
    read_text_if_exists(&data_root.join("personas").join("active.md"))
}

pub(super) fn bounded_persona(value: &str) -> String {
    if value.encode_utf16().count() <= 3_000 {
        return value.to_owned();
    }
    format!(
        "{}\n...",
        butler_core::public_text::trim_js_whitespace_end(prefix_utf16(value, 3_000))
    )
}

pub(super) fn safe_config_text(value: Option<&Value>) -> String {
    let Some(value) = value.and_then(Value::as_str) else {
        return String::new();
    };
    safe_config_string(value)
}

pub(super) fn safe_config_string(value: &str) -> String {
    let mut normalized = String::with_capacity(value.len());
    let mut whitespace = false;
    for character in value.chars() {
        if butler_core::public_text::is_js_whitespace(character) {
            whitespace = true;
        } else {
            if whitespace && !normalized.is_empty() {
                normalized.push(' ');
            }
            whitespace = false;
            normalized.push(character);
        }
    }
    prefix_utf16(
        butler_core::public_text::trim_js_whitespace(&normalized),
        180,
    )
    .to_owned()
}

pub(super) fn resolve_language(
    explicit: Option<&str>,
    environment: Option<&str>,
    config: &Value,
    persona: Option<&str>,
) -> &'static str {
    normalize_language(explicit)
        .or_else(|| normalize_language(environment))
        .or_else(|| {
            normalize_language(
                config
                    .pointer("/user/responseLanguage")
                    .and_then(Value::as_str),
            )
        })
        .or_else(|| normalize_language(persona.and_then(persona_language)))
        .unwrap_or("en")
}

fn normalize_language(value: Option<&str>) -> Option<&'static str> {
    let normalized = butler_core::public_text::trim_js_whitespace(value?).to_lowercase();
    if normalized.is_empty() {
        return None;
    }
    if normalized == "ko"
        || normalized == "kr"
        || normalized.contains("korean")
        || normalized.contains("한국")
        || normalized.contains("한글")
    {
        Some("ko")
    } else if normalized == "en" || normalized.contains("english") || normalized.contains("영어")
    {
        Some("en")
    } else {
        None
    }
}

fn persona_language(value: &str) -> Option<&str> {
    let lower = value.to_ascii_lowercase();
    let marker = "**language:**";
    let start = lower.find(marker)? + marker.len();
    let remainder = &value[start..];
    let start = remainder
        .char_indices()
        .find(|(_, value)| !butler_core::public_text::is_js_whitespace(*value))
        .map_or(remainder.len(), |(index, _)| index);
    Some(remainder[start..].split('\n').next().unwrap_or(""))
}

fn join(root: &Path, parts: &[&str]) -> PathBuf {
    parts
        .iter()
        .fold(root.to_owned(), |path, part| path.join(part))
}
