//! New-chat briefing artifacts: the model's JSON reply read leniently and
//! turned into the stored artifact.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::contracts::{
    BriefingGenerationError, BriefingInputSnapshot, BriefingProjectSignal, error,
};
use super::prompt;
use crate::cognition::BriefingGenerationCode;
use crate::lenient::{self, Obj};

#[derive(Clone, Copy)]
pub(super) struct BriefingArtifactContext<'a> {
    pub(super) input: &'a BriefingInputSnapshot,
    pub(super) project: Option<&'a BriefingProjectSignal>,
    pub(super) now: DateTime<Utc>,
    pub(super) local_minute: u16,
    pub(super) run_id: &'a str,
    pub(super) model: &'a str,
    pub(super) reasoning: &'a str,
}

/// A new-chat briefing as written to `briefings/<date>/…json`, fields in
/// the stored order.
#[derive(Serialize)]
pub(super) struct BriefingArtifact<'a> {
    schema: &'static str,
    briefing_id: String,
    scope: &'static str,
    project_id: Option<&'a str>,
    project_name: Option<&'a str>,
    locale: &'a str,
    moment: String,
    title: String,
    description: String,
    suggestions: Vec<Suggestion>,
    source: ArtifactSource<'a>,
    raw_text_included: bool,
    /// Only the general briefing has greetings per time of day.
    #[serde(skip_serializing_if = "Option::is_none")]
    title_variants: Option<TitleVariants>,
}

/// One suggested conversation starter.
#[derive(Serialize)]
struct Suggestion {
    id: String,
    title: String,
    description: String,
    text: String,
    source_kind: &'static str,
}

/// Where the briefing came from.
#[derive(Serialize)]
struct ArtifactSource<'a> {
    consolidation_run_id: &'a str,
    generated_at: String,
    persona_id: Option<&'a str>,
    persona_applied: bool,
    profile_projection_id: Option<&'static str>,
    profile_projection_updated_at: Option<&'a str>,
    project_ledger_snapshot_id: Option<String>,
    model_ref: &'a str,
    reasoning_effort: &'a str,
    raw_text_included: bool,
}

#[derive(Serialize)]
struct TitleVariants {
    morning: String,
    afternoon: String,
    evening: String,
    night: String,
}

/// The model's reply; a field with the wrong type reads as absent.
#[derive(Default, Deserialize)]
#[serde(default)]
struct RawBriefing {
    #[serde(deserialize_with = "lenient::option")]
    moment: Option<String>,
    #[serde(deserialize_with = "lenient::option")]
    title: Option<String>,
    #[serde(deserialize_with = "lenient::option")]
    description: Option<String>,
    #[serde(deserialize_with = "lenient::items")]
    suggestions: Option<Vec<Option<RawSuggestion>>>,
    #[serde(deserialize_with = "lenient::option")]
    title_variants: Option<Obj<RawVariants>>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct RawSuggestion {
    #[serde(deserialize_with = "lenient::option")]
    id: Option<String>,
    #[serde(deserialize_with = "lenient::option")]
    title: Option<String>,
    #[serde(deserialize_with = "lenient::option")]
    description: Option<String>,
    #[serde(deserialize_with = "lenient::option")]
    text: Option<String>,
    #[serde(deserialize_with = "lenient::option")]
    source_kind: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct RawVariants {
    #[serde(deserialize_with = "lenient::option")]
    morning: Option<String>,
    #[serde(deserialize_with = "lenient::option")]
    afternoon: Option<String>,
    #[serde(deserialize_with = "lenient::option")]
    evening: Option<String>,
    #[serde(deserialize_with = "lenient::option")]
    night: Option<String>,
}

const SOURCE_KINDS: &[&str] = &[
    "unfinished_topic",
    "repeated_question",
    "current_interest",
    "adjacent_direction",
    "timely_context",
    "project_status",
    "project_decision",
    "project_quality_risk",
    "project_next_step",
];

pub(super) fn from_model<'a>(
    raw: &str,
    context: BriefingArtifactContext<'a>,
) -> Result<BriefingArtifact<'a>, BriefingGenerationError> {
    let BriefingArtifactContext {
        input,
        project,
        now,
        local_minute,
        run_id,
        model,
        reasoning,
    } = context;
    let parsed = reply(raw)?;
    let scope = if project.is_some() {
        "project"
    } else {
        "general"
    };
    let mut suggestions = suggestions(parsed.suggestions.unwrap_or_default(), scope);
    if let Some(project) = project {
        suggestions.retain(|suggestion| {
            let serialized = serde_json::to_string(suggestion)
                .unwrap_or_default()
                .to_lowercase();
            !project
                .excluded_topics
                .iter()
                .any(|topic| serialized.contains(&topic.to_lowercase()))
        });
    }
    if suggestions.len() < 4 {
        return Err(invalid("at least four valid suggestions"));
    }
    let locale = prompt::locale(input);
    let moment = optional_text(parsed.moment.as_deref())
        .unwrap_or_else(|| prompt::moment(local_minute, locale));
    let title = required_text(parsed.title.as_deref(), "title")?;
    let description = required_text(parsed.description.as_deref(), "description")?;
    let title_variants = match project {
        Some(_) => None,
        None => Some(title_variants(
            parsed.title_variants.map(|variants| variants.0),
        )?),
    };
    Ok(BriefingArtifact {
        schema: "butler.cognition.new-chat-briefing.v1",
        briefing_id: format!("ncb_{}", uuid::Uuid::new_v4()),
        scope,
        project_id: project.map(|value| value.id.as_str()),
        project_name: project.map(|value| value.display_name.as_str()),
        locale,
        moment,
        title,
        description,
        suggestions,
        source: ArtifactSource {
            consolidation_run_id: run_id,
            generated_at: now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            persona_id: input.persona.id.as_deref(),
            persona_applied: input
                .persona
                .text
                .as_deref()
                .is_some_and(|text| !text.is_empty()),
            profile_projection_id: input.projection.as_ref().map(|_| "active"),
            profile_projection_updated_at: input
                .projection
                .as_ref()
                .map(|value| value.updated_at.as_str()),
            project_ledger_snapshot_id: project.map(|value| format!("{}:safe-summary", value.id)),
            model_ref: model,
            reasoning_effort: reasoning,
            raw_text_included: false,
        },
        raw_text_included: false,
        title_variants,
    })
}

/// The JSON object in the model's reply, fences and prose around it
/// ignored.
fn reply(raw: &str) -> Result<RawBriefing, BriefingGenerationError> {
    let trimmed = raw
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let start = trimmed.find('{').ok_or_else(|| invalid("JSON object"))?;
    let end = trimmed.rfind('}').ok_or_else(|| invalid("JSON object"))?;
    let object = trimmed
        .get(start..=end)
        .filter(|_| end > start)
        .ok_or_else(|| invalid("JSON object"))?;
    let parsed: Value = serde_json::from_str(object)
        .map_err(|source| invalid("JSON object").with_source(source))?;
    Ok(lenient::view(&parsed))
}

fn title_variants(raw: Option<RawVariants>) -> Result<TitleVariants, BriefingGenerationError> {
    let raw = raw.unwrap_or_default();
    Ok(TitleVariants {
        morning: required_text(raw.morning.as_deref(), "morning")?,
        afternoon: required_text(raw.afternoon.as_deref(), "afternoon")?,
        evening: required_text(raw.evening.as_deref(), "evening")?,
        night: required_text(raw.night.as_deref(), "night")?,
    })
}

/// Up to six complete suggestions with unique ids; an unknown source kind
/// falls back to the scope's default.
fn suggestions(items: Vec<Option<RawSuggestion>>, scope: &str) -> Vec<Suggestion> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for item in items.into_iter().flatten() {
        let (Some(title), Some(description), Some(text)) = (
            optional_text(item.title.as_deref()),
            optional_text(item.description.as_deref()),
            optional_text(item.text.as_deref()),
        ) else {
            continue;
        };
        let id = safe_id(&optional_text(item.id.as_deref()).unwrap_or_else(|| title.clone()));
        if !seen.insert(id.clone()) {
            continue;
        }
        let source_kind = item
            .source_kind
            .and_then(|kind| SOURCE_KINDS.iter().copied().find(|known| *known == kind))
            .unwrap_or(if scope == "project" {
                "project_next_step"
            } else {
                "current_interest"
            });
        out.push(Suggestion {
            id,
            title,
            description,
            text,
            source_kind,
        });
        if out.len() == 6 {
            break;
        }
    }
    out
}

fn safe_id(value: &str) -> String {
    let mut result = String::new();
    for ch in value.to_lowercase().trim().chars() {
        if ch.is_ascii_lowercase()
            || ch.is_ascii_digit()
            || ('가'..='힣').contains(&ch)
            || matches!(ch, '.' | '_' | '-')
        {
            result.push(ch);
        } else if !result.is_empty() && !result.ends_with('-') {
            result.push('-');
        }
        if result.len() >= 80 {
            break;
        }
    }
    let result = result.trim_matches('-').to_owned();
    if result.is_empty() {
        let id = uuid::Uuid::new_v4().simple().to_string();
        format!("card-{}", id.get(..8).unwrap_or(&id))
    } else {
        result
    }
}

fn optional_text(value: Option<&str>) -> Option<String> {
    value
        .map(|text| text.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|text| !text.is_empty())
}

fn required_text(value: Option<&str>, label: &str) -> Result<String, BriefingGenerationError> {
    optional_text(value).ok_or_else(|| invalid(label))
}

fn invalid(label: &str) -> BriefingGenerationError {
    error(
        BriefingGenerationCode::NewChatBriefingInvalidModelOutput,
        format!("New chat briefing model omitted {label}"),
    )
}
