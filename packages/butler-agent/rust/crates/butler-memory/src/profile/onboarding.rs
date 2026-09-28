//! First-chat onboarding: the stored onboarding state, the fields a user
//! fills in during the first chat, and applying the chosen persona.

mod prompt;
pub(super) use prompt::render;
use std::collections::HashSet;
use std::fs;
use std::path::Path;

use serde::Deserialize;
use serde_json::{Map, Value};

use super::contracts::{
    FirstChatOnboardingFields, FirstChatOnboardingState, FirstChatOnboardingUpdate,
    PersonalizationProfile, ProfileError, ProfileResult, ProfilingMode,
};
use super::naming;
use super::presets::{PersonaLocale, PersonaPresets, safe_persona_preset_name};
use crate::lenient::{self, Obj};
use crate::profile::ProfileCode;

pub(super) const STORAGE_LABEL: &str = "personalization/onboarding.json";

pub(super) fn read(data_root: &Path, now: &str) -> FirstChatOnboardingState {
    let Ok(bytes) = fs::read(data_root.join(STORAGE_LABEL)) else {
        return default_state(now);
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return default_state(now);
    };
    normalize_state(lenient::view(&value), now)
}

pub(super) fn write(
    data_root: &Path,
    state: &FirstChatOnboardingState,
    pid: u32,
    now_ms: i64,
) -> ProfileResult<FirstChatOnboardingState> {
    let value = serde_json::to_value(state).map_err(|source| error().with_source(source))?;
    let normalized = normalize_state(lenient::view(&value), &state.updated_at);
    naming::atomic_json(&data_root.join(STORAGE_LABEL), &normalized, pid, now_ms)?;
    Ok(normalized)
}

pub(super) fn apply_update_fields(
    state: &mut FirstChatOnboardingState,
    input: &FirstChatOnboardingUpdate,
    selected_persona: Option<&str>,
) -> Vec<String> {
    let mut updated = Vec::new();
    for (name, source, target, limit) in [
        (
            "interests",
            &input.interests,
            &mut state.fields.interests,
            1_000,
        ),
        ("work", &input.work, &mut state.fields.work, 1_000),
        (
            "service_preference",
            &input.service_preference,
            &mut state.fields.service_preference,
            1_000,
        ),
        (
            "persona_custom",
            &input.persona_custom,
            &mut state.fields.persona_custom,
            1_000,
        ),
    ] {
        if let Some(value) = source {
            *target = Some(naming::bounded(value, limit));
            updated.push(name.into());
        }
    }
    if let Some(value) = selected_persona {
        state.fields.persona_preset = Some(value.into());
        updated.push("persona_preset".into());
    }
    if let Some(mode) = input.profiling_mode {
        state.fields.profiling_mode = Some(mode);
        updated.push("profiling_mode".into());
    }
    let mut seen = HashSet::new();
    state
        .skipped_fields
        .extend(input.skipped_fields.iter().filter_map(|value| {
            let value = butler_core::public_text::trim_js_whitespace(value);
            (!value.is_empty()).then(|| value.to_owned())
        }));
    state
        .skipped_fields
        .retain(|value| seen.insert(value.clone()));
    state.skipped_fields.truncate(12);
    updated
}

pub(super) fn resolve_persona_selection(
    presets: &PersonaPresets,
    locale: PersonaLocale,
    selection: Option<&str>,
    custom_text: Option<&str>,
) -> Option<String> {
    let Some(selection) = selection else {
        return custom_text
            .map(|value| naming::bounded(value, 1_000))
            .filter(|value| !value.is_empty())
            .map(|_| "custom".into());
    };
    let selection = butler_core::public_text::trim_js_whitespace(selection);
    if selection.is_empty() {
        return None;
    }
    if custom(selection) {
        return Some("custom".into());
    }
    let explicit = persona_id(selection).unwrap_or(selection);
    if let Some(name) = safe_persona_preset_name(explicit)
        && let Some(preset) = presets.read(locale, name)
    {
        return Some(preset.name);
    }
    let normalized = normalize_selection(selection);
    presets.list(locale).into_iter().find_map(|preset| {
        let label = if preset.label == preset.name {
            preset.name.clone()
        } else {
            format!("{} ({})", preset.name, preset.label)
        };
        let aliases = [
            preset.name.clone(),
            preset.label.clone(),
            format!("persona_preset: {}", preset.name),
            label,
        ];
        aliases
            .into_iter()
            .any(|alias| normalize_selection(&alias) == normalized)
            .then_some(preset.name)
    })
}

pub(super) fn apply_persona(
    data_root: &Path,
    presets: &PersonaPresets,
    state: &FirstChatOnboardingState,
    profile: &PersonalizationProfile,
    selected: Option<&str>,
    locale: PersonaLocale,
) -> ProfileResult<bool> {
    let name = if profile.butler_nickname.is_empty() {
        "Butler"
    } else {
        &profile.butler_nickname
    };
    let Some(selected) = selected else {
        return Ok(false);
    };
    let (output, applied_locale) = if selected == "custom" {
        let Some(text) = state
            .fields
            .persona_custom
            .as_deref()
            .filter(|value| !value.is_empty())
        else {
            return Ok(false);
        };
        (
            format!(
                "---\nname: active\ndescription: Custom persona copied from first-chat onboarding.\nbase: custom\n---\n# {name}\n\nUse this principal-provided treatment and voice preference:\n\n{text}\n"
            ),
            "custom",
        )
    } else {
        let Some(preset) = presets.read(locale, selected) else {
            return Ok(false);
        };
        let applied_locale = locale_str(preset.locale);
        (
            preset.content.replace("{{butler_name}}", name),
            applied_locale,
        )
    };
    let path = data_root.join("personas/active.md");
    fs::create_dir_all(data_root.join("personas")).map_err(|source| error().with_source(source))?;
    fs::write(
        &path,
        if output.ends_with('\n') {
            output
        } else {
            format!("{output}\n")
        },
    )
    .map_err(|source| error().with_source(source))?;
    let config_path = data_root.join("butler.config.json");
    let mut config = fs::read(&config_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| Value::Object(Map::new()));
    object(&mut config, "butler").insert("name".into(), Value::String(name.into()));
    let system = object(&mut config, "system");
    system.insert("activePersona".into(), Value::String(selected.into()));
    system.insert(
        "activePersonaLocale".into(),
        Value::String(applied_locale.into()),
    );
    let mut bytes =
        serde_json::to_vec_pretty(&config).map_err(|source| error().with_source(source))?;
    bytes.push(b'\n');
    fs::write(config_path, bytes).map_err(|source| error().with_source(source))?;
    Ok(true)
}

/// The onboarding file as stored; a field with the wrong type reads as
/// absent.
#[derive(Default, Deserialize)]
#[serde(default)]
struct StoredOnboarding {
    #[serde(deserialize_with = "lenient::option")]
    status: Option<String>,
    #[serde(deserialize_with = "lenient::option")]
    fields: Option<Obj<StoredFields>>,
    #[serde(deserialize_with = "lenient::string_list")]
    skipped_fields: Vec<String>,
    #[serde(deserialize_with = "lenient::option")]
    created_at: Option<String>,
    #[serde(deserialize_with = "lenient::option")]
    updated_at: Option<String>,
    #[serde(deserialize_with = "lenient::option")]
    completed_at: Option<String>,
}

/// The stored onboarding answers.
#[derive(Default, Deserialize)]
#[serde(default)]
struct StoredFields {
    #[serde(deserialize_with = "lenient::option")]
    interests: Option<String>,
    #[serde(deserialize_with = "lenient::option")]
    work: Option<String>,
    #[serde(deserialize_with = "lenient::option")]
    service_preference: Option<String>,
    #[serde(deserialize_with = "lenient::option")]
    persona_custom: Option<String>,
    #[serde(deserialize_with = "lenient::option")]
    persona_preset: Option<String>,
    #[serde(deserialize_with = "lenient::option")]
    profiling_mode: Option<String>,
}

fn normalize_state(stored: StoredOnboarding, now: &str) -> FirstChatOnboardingState {
    FirstChatOnboardingState {
        schema: "butler.first_chat_onboarding.v1".into(),
        status: if stored.status.as_deref() == Some("complete") {
            "complete".into()
        } else {
            "pending".into()
        },
        gateway: "any".into(),
        fields: normalize_fields(stored.fields.map(|fields| fields.0).unwrap_or_default()),
        skipped_fields: stored
            .skipped_fields
            .iter()
            .map(|value| butler_core::public_text::trim_js_whitespace(value))
            .filter(|value| !value.is_empty())
            .take(12)
            .map(str::to_owned)
            .collect(),
        created_at: stored.created_at.unwrap_or_else(|| now.into()),
        updated_at: stored.updated_at.unwrap_or_else(|| now.into()),
        completed_at: stored.completed_at,
    }
}

fn normalize_fields(stored: StoredFields) -> FirstChatOnboardingFields {
    let text = |value: Option<String>, limit| value.map(|value| naming::bounded(&value, limit));
    FirstChatOnboardingFields {
        interests: text(stored.interests, 1_000),
        work: text(stored.work, 1_000),
        service_preference: text(stored.service_preference, 1_000),
        persona_custom: text(stored.persona_custom, 1_000),
        persona_preset: text(stored.persona_preset, 256).and_then(|value| {
            if custom(&value) {
                Some("custom".into())
            } else {
                safe_persona_preset_name(&value).map(str::to_owned)
            }
        }),
        profiling_mode: stored.profiling_mode.as_deref().map(ProfilingMode::parse),
    }
}

fn default_state(now: &str) -> FirstChatOnboardingState {
    FirstChatOnboardingState {
        schema: "butler.first_chat_onboarding.v1".into(),
        status: "pending".into(),
        gateway: "any".into(),
        fields: Default::default(),
        skipped_fields: Vec::new(),
        created_at: now.into(),
        updated_at: now.into(),
        completed_at: None,
    }
}
fn custom(value: &str) -> bool {
    matches!(
        value.to_lowercase().as_str(),
        "custom" | "direct editing" | "직접 편집"
    )
}
fn persona_id(value: &str) -> Option<&str> {
    let marker = "persona_preset:";
    let start = value.find(marker)? + marker.len();
    let value = butler_core::public_text::trim_js_whitespace(&value[start..]);
    let value = value.strip_prefix('`').unwrap_or(value);
    let end = value
        .find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '`')))
        .unwrap_or(value.len());
    value[..end]
        .strip_suffix('`')
        .or(Some(&value[..end]))
        .filter(|value| !value.is_empty())
}
fn normalize_selection(value: &str) -> String {
    let value = butler_core::public_text::trim_js_whitespace(value);
    let value = value
        .strip_prefix('-')
        .or_else(|| value.strip_prefix('*'))
        .map(butler_core::public_text::trim_js_whitespace)
        .unwrap_or(value);
    let value = value.replace(['`', '"', '“', '”'], "");
    super::naming::collapse_js_whitespace(&value).to_lowercase()
}
fn locale_str(value: PersonaLocale) -> &'static str {
    match value {
        PersonaLocale::En => "en",
        PersonaLocale::Ko => "ko",
    }
}
/// Passthrough: `butler.config.json` is edited in place, so keys owned by
/// other components survive.
fn object<'a>(root: &'a mut Value, key: &str) -> &'a mut Map<String, Value> {
    butler_core::json::object_field_mut(butler_core::json::object_mut(root), key)
}
fn error() -> ProfileError {
    ProfileError::new(
        ProfileCode::ProfileWriteFailed,
        "Profile could not be written.",
    )
}
