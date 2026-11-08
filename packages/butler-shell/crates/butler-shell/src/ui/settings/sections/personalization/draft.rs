//! The personalization view and its editable draft (`PersonalizationView`, `PersonalizationDraft`,
//! `draftFromPersonalization`, `personalizationUpdatePayload`, `selectPersonaPreset` of
//! `stores/settingsUIStore.ts`). The draft is compared with what the draft of the stored view
//! would be, so "has changes" and the PATCH body read the same differences.
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::ui::composer::queue::effort_wire;
use crate::ui::source::wire::ReasoningEffort;

/// The wire names of the three profile fields, in field order.
pub(super) const PROFILE_KEYS: [&str; 3] =
    ["butler_nickname", "principal_name", "preferred_address"];

#[derive(Clone, Default, Deserialize)]
#[serde(default)]
pub(super) struct Preset {
    pub(super) name: String,
    pub(super) label: String,
    pub(super) preview: String,
    pub(super) content: String,
}

#[derive(Clone, Default, Deserialize)]
#[serde(default)]
struct Profile {
    butler_nickname: String,
    principal_name: String,
    preferred_address: String,
}

#[derive(Clone, Default, Deserialize)]
#[serde(default)]
struct Profiling {
    mode: String,
    extractor_model: String,
    extractor_reasoning_effort: Option<ReasoningEffort>,
}

/// GET /personalization
#[derive(Clone, Default, Deserialize)]
#[serde(default)]
pub(super) struct Personalization {
    persona: String,
    eol: String,
    pub(super) updated_at: String,
    response_language: Option<String>,
    pub(super) persona_presets: Vec<Preset>,
    profile: Option<Profile>,
    profiling: Option<Profiling>,
}

#[derive(Clone, PartialEq)]
pub(super) struct Draft {
    pub(super) persona: String,
    pub(super) eol: String,
    /// "en" or "ko"
    pub(super) response_language: String,
    /// A preset name, or "custom".
    pub(super) persona_preset: String,
    pub(super) profile: [String; 3],
    /// "off", "basic" or "deep"
    pub(super) mode: String,
    /// A model ref, or "default".
    pub(super) extractor_model: String,
    pub(super) effort: ReasoningEffort,
}

impl Default for Draft {
    fn default() -> Self {
        Self::from(&Personalization::default())
    }
}

impl From<&Personalization> for Draft {
    fn from(view: &Personalization) -> Self {
        let profile = view.profile.clone().unwrap_or_default();
        let profiling = view.profiling.clone().unwrap_or_default();
        let effort = match profiling.extractor_reasoning_effort {
            Some(ReasoningEffort::Unknown) | None => ReasoningEffort::Medium,
            Some(effort) => effort,
        };
        Self {
            persona: editable(&view.persona).to_owned(),
            eol: view.eol.clone(),
            response_language: language_of(view.response_language.as_deref()).to_owned(),
            persona_preset: resolve_preset(&view.persona, &view.persona_presets),
            profile: [
                profile.butler_nickname,
                profile.principal_name,
                profile.preferred_address,
            ],
            mode: match profiling.mode.as_str() {
                mode @ ("basic" | "deep") => mode.to_owned(),
                _ => "off".to_owned(),
            },
            extractor_model: if profiling.extractor_model.trim().is_empty() {
                "default".to_owned()
            } else {
                profiling.extractor_model
            },
            effort,
        }
    }
}

fn language_of(value: Option<&str>) -> &'static str {
    if value == Some("ko") { "ko" } else { "en" }
}

impl Draft {
    /// `selectPersonaPreset`: a preset replaces the persona text; an unknown name changes nothing.
    pub(super) fn select_preset(&mut self, presets: &[Preset], name: &str) {
        if name == "custom" {
            "custom".clone_into(&mut self.persona_preset);
        } else if let Some(preset) = presets.iter().find(|preset| preset.name == name) {
            editable(&preset.content).clone_into(&mut self.persona);
            preset.name.clone_into(&mut self.persona_preset);
        }
    }
}

/// `^---\r?\n([\s\S]*?)\r?\n---` and the text after the closing fence; `strict` also wants the
/// fence to end its line (`(?:\r?\n|$)`).
fn frontmatter(text: &str, strict: bool) -> Option<(&str, &str)> {
    let body = text
        .strip_prefix("---\r\n")
        .or_else(|| text.strip_prefix("---\n"))?;
    body.match_indices("\n---").find_map(|(at, fence)| {
        let after = &body[at + fence.len()..];
        let closed =
            !strict || after.is_empty() || after.starts_with('\n') || after.starts_with("\r\n");
        closed.then(|| (body[..at].trim_end_matches('\r'), after))
    })
}

/// `editablePersonaText`: the persona without its frontmatter.
fn editable(text: &str) -> &str {
    let Some((_, mut rest)) = frontmatter(text, false) else {
        return text;
    };
    for _ in 0..2 {
        rest = rest
            .strip_prefix("\r\n")
            .or_else(|| rest.strip_prefix('\n'))
            .unwrap_or(rest);
    }
    rest
}

/// `readFrontmatterField`
fn field(text: &str, name: &str) -> Option<String> {
    let (inner, _) = frontmatter(text, true)?;
    let value = inner.lines().find_map(|line| {
        line.strip_prefix(name)?
            .strip_prefix(':')
            .filter(|value| !value.is_empty())
    })?;
    let value = value.trim();
    let value = value.strip_prefix('"').unwrap_or(value);
    Some(value.strip_suffix('"').unwrap_or(value).to_owned())
}

/// `resolvePersonaPreset`: the preset the persona names, else the one it equals, else "custom".
fn resolve_preset(persona: &str, presets: &[Preset]) -> String {
    let base = field(persona, "base").or_else(|| field(persona, "name"));
    if let Some(base) = base
        && base != "active"
        && presets.iter().any(|preset| preset.name == base)
    {
        return base;
    }
    presets
        .iter()
        .find(|preset| {
            preset.content.trim() == persona.trim()
                || editable(&preset.content).trim() == editable(persona).trim()
        })
        .map_or_else(|| "custom".to_owned(), |preset| preset.name.clone())
}

/// `personaPayloadFromDraft`: an untouched preset is saved as the preset's own text.
fn persona_payload(view: &Personalization, draft: &Draft) -> String {
    match view
        .persona_presets
        .iter()
        .find(|preset| preset.name == draft.persona_preset)
    {
        Some(preset) if editable(&preset.content).trim() == draft.persona.trim() => {
            preset.content.clone()
        }
        _ => draft.persona.clone(),
    }
}

/// `personalizationUpdatePayload` for a loaded view: only the fields that differ.
pub(super) fn update_payload(view: &Personalization, draft: &Draft) -> Value {
    let base = Draft::from(view);
    let mut payload = Map::new();
    if draft.persona != base.persona || draft.persona_preset != base.persona_preset {
        payload.insert("persona".into(), persona_payload(view, draft).into());
    }
    if draft.eol != base.eol {
        payload.insert("eol".into(), draft.eol.clone().into());
    }
    if draft.response_language != base.response_language {
        payload.insert(
            "response_language".into(),
            draft.response_language.clone().into(),
        );
    }
    if draft.profile != base.profile {
        let profile: Map<String, Value> = PROFILE_KEYS
            .iter()
            .zip(&draft.profile)
            .map(|(key, value)| ((*key).to_owned(), value.clone().into()))
            .collect();
        payload.insert("profile".into(), Value::Object(profile));
    }
    let mut profiling = Map::new();
    if draft.mode != base.mode {
        profiling.insert("mode".into(), draft.mode.clone().into());
    }
    if draft.extractor_model != base.extractor_model {
        profiling.insert(
            "extractor_model".into(),
            draft.extractor_model.clone().into(),
        );
    }
    if draft.effort != base.effort
        && let Some(effort) = effort_wire(&draft.effort)
    {
        profiling.insert("extractor_reasoning_effort".into(), effort.into());
    }
    if !profiling.is_empty() {
        payload.insert("profiling".into(), Value::Object(profiling));
    }
    Value::Object(payload)
}
