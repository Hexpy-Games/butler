use chrono::{DateTime, Utc};
use serde_json::{Value, json};

use super::contracts::{
    BriefingGenerationError, BriefingInputSnapshot, BriefingProjectSignal, error,
};
use super::prompt;

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

pub(super) fn from_model(
    raw: &str,
    context: BriefingArtifactContext<'_>,
) -> Result<Value, BriefingGenerationError> {
    let BriefingArtifactContext {
        input,
        project,
        now,
        local_minute,
        run_id,
        model,
        reasoning,
    } = context;
    let trimmed = raw
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let start = trimmed.find('{').ok_or_else(|| invalid("JSON object"))?;
    let end = trimmed.rfind('}').ok_or_else(|| invalid("JSON object"))?;
    if end <= start {
        return Err(invalid("JSON object"));
    }
    let parsed: Value =
        serde_json::from_str(&trimmed[start..=end]).map_err(|_| invalid("JSON object"))?;
    let scope = if project.is_some() {
        "project"
    } else {
        "general"
    };
    let mut suggestions = suggestions(&parsed["suggestions"], scope);
    if let Some(project) = project {
        suggestions.retain(|suggestion| {
            let serialized = suggestion.to_string().to_lowercase();
            !project
                .excluded_topics
                .iter()
                .any(|topic| serialized.contains(&topic.to_lowercase()))
        });
    }
    if suggestions.len() < 4 {
        return Err(invalid("at least four valid suggestions"));
    }
    let mut artifact = json!({
        "schema":"butler.cognition.new-chat-briefing.v1",
        "briefing_id":format!("ncb_{}", uuid::Uuid::new_v4()),
        "scope":scope,
        "project_id":project.map(|value| value.id.as_str()),
        "project_name":project.map(|value| value.display_name.as_str()),
        "locale":prompt::locale(input),
        "moment":optional_text(&parsed["moment"]).unwrap_or_else(|| prompt::moment(local_minute, prompt::locale(input))),
        "title":required_text(&parsed["title"], "title")?,
        "description":required_text(&parsed["description"], "description")?,
        "suggestions":suggestions,
        "source":{
            "consolidation_run_id":run_id,
            "generated_at":now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "persona_id":input.persona.id,
            "persona_applied":input.persona.text.as_deref().is_some_and(|text| !text.is_empty()),
            "profile_projection_id":input.projection.as_ref().map(|_| "active"),
            "profile_projection_updated_at":input.projection.as_ref().map(|value| value.updated_at.as_str()),
            "project_ledger_snapshot_id":project.map(|value| format!("{}:safe-summary", value.id)),
            "model_ref":model,
            "reasoning_effort":reasoning,
            "raw_text_included":false,
        },
        "raw_text_included":false,
    });
    if project.is_none() {
        let variants = &parsed["title_variants"];
        let mut normalized = serde_json::Map::new();
        for key in ["morning", "afternoon", "evening", "night"] {
            normalized.insert(key.into(), required_text(&variants[key], key)?.into());
        }
        artifact["title_variants"] = Value::Object(normalized);
    }
    Ok(artifact)
}

fn suggestions(value: &Value, scope: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for item in value.as_array().into_iter().flatten() {
        let (Some(title), Some(description), Some(text)) = (
            optional_text(&item["title"]),
            optional_text(&item["description"]),
            optional_text(&item["text"]),
        ) else {
            continue;
        };
        let id = safe_id(&optional_text(&item["id"]).unwrap_or_else(|| title.clone()));
        if !seen.insert(id.clone()) {
            continue;
        }
        let kind = item["source_kind"]
            .as_str()
            .filter(|value| {
                matches!(
                    *value,
                    "unfinished_topic"
                        | "repeated_question"
                        | "current_interest"
                        | "adjacent_direction"
                        | "timely_context"
                        | "project_status"
                        | "project_decision"
                        | "project_quality_risk"
                        | "project_next_step"
                )
            })
            .unwrap_or(if scope == "project" {
                "project_next_step"
            } else {
                "current_interest"
            });
        out.push(
            json!({"id":id,"title":title,"description":description,"text":text,"source_kind":kind}),
        );
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
        format!("card-{}", &uuid::Uuid::new_v4().simple().to_string()[..8])
    } else {
        result
    }
}

fn optional_text(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(|text| text.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|text| !text.is_empty())
}

fn required_text(value: &Value, label: &str) -> Result<String, BriefingGenerationError> {
    optional_text(value).ok_or_else(|| invalid(label))
}

fn invalid(label: &str) -> BriefingGenerationError {
    error(
        "new_chat_briefing_invalid_model_output",
        format!("New chat briefing model omitted {label}"),
    )
}
