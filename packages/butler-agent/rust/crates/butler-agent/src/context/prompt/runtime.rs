use serde_json::{Map, Value};

use crate::btcc::{AttachmentKind, ContextSection, TurnRequest};
use crate::context::{ContextResult, ProjectCapsuleStatus, PromptClock, PromptEnvironment};
use crate::workspace::{SessionRole, StoredSessionBinding};

use super::files::{safe_config_string, safe_config_text};

#[derive(Clone, Copy)]
pub(super) struct RuntimeStateInput<'a> {
    pub binding: &'a StoredSessionBinding,
    pub request: &'a TurnRequest,
    pub config: &'a Value,
    pub environment: &'a PromptEnvironment,
    pub clock: &'a dyn PromptClock,
    pub response_language: &'a str,
    pub live_config_hash: &'a str,
    pub project_status: ProjectCapsuleStatus,
}

pub(super) fn runtime_state(input: RuntimeStateInput<'_>) -> ContextResult<ContextSection> {
    let timestamp = if input.request.message.timestamp.is_empty() {
        input.clock.now_epoch_millis()
    } else {
        input
            .clock
            .parse_timestamp(&input.request.message.timestamp)
            .unwrap_or_else(|| input.clock.now_epoch_millis())
    };
    let user = input.config.get("user").and_then(Value::as_object);
    let timezone = safe_config_text(user.and_then(|value| value.get("timezone")));
    let timezone = if timezone.is_empty() {
        "UTC"
    } else {
        &timezone
    };
    let language = safe_config_text(user.and_then(|value| value.get("language")));
    let language = if language.is_empty() {
        "unknown"
    } else {
        &language
    };
    let technical = safe_config_text(user.and_then(|value| value.get("techLanguage")));
    let utc = input.clock.iso_from_epoch_millis(timestamp)?;
    let local = input
        .clock
        .format_local_time(timestamp, timezone)
        .unwrap_or_else(|_| utc.clone());
    let geo = best_geo_hint(user, input.environment.user_geo.as_deref(), timezone);
    let mut lines = vec![
        format!("Live Configuration Hash: {}", input.live_config_hash),
        format!("Session ID: {}", input.binding.session_id),
        format!("Session Role: {}", role_text(&input.binding.role)),
        "## Turn Environment".into(),
        format!("Current Time UTC: {utc}"),
        format!("Current Local Time: {local}"),
        format!("User Timezone: {timezone}"),
        format!("Interface Language (app labels only): {language}"),
        format!("Assistant Response Language: {}", input.response_language),
    ];
    if !technical.is_empty() {
        lines.push(format!("User Technical Language: {technical}"));
    }
    lines.push(format!("User Geo Hint: {geo}"));
    if let Some(project) = &input.binding.project_id {
        lines.push(format!("Project ID: {project}"));
        lines.push(format!(
            "Project Memory Status: {}",
            project_status_text(input.project_status)
        ));
    }
    lines.push(format!("Workspace Path: {}", input.binding.workspace_path));
    Ok(section(
        "runtime-state",
        "Runtime State",
        lines.join("\n"),
        "runtime_state",
        "mandatory_hot_cache",
        "session",
    ))
}

pub(super) fn current_input(request: &TurnRequest) -> ContextSection {
    section(
        "inbound-message",
        "Current User Input",
        format!(
            "Message Text: {}",
            crate::public_text::trim_js_whitespace(&request.message.content)
        ),
        "current_input",
        "optional_hot_cache",
        "session",
    )
}

pub(super) fn current_attachments(
    request: &TurnRequest,
    binding: &StoredSessionBinding,
) -> Option<ContextSection> {
    let lines = request
        .message
        .attachments
        .iter()
        .filter(|attachment| !attachment.id.is_empty())
        .take(12)
        .enumerate()
        .map(|(index, attachment)| {
            let name = attachment
                .file_name
                .as_deref()
                .map(crate::public_text::trim_js_whitespace)
                .filter(|value| !value.is_empty())
                .map_or_else(|| format!("attachment-{}", index + 1), str::to_owned);
            let mime = attachment
                .mime_type
                .as_deref()
                .map(crate::public_text::trim_js_whitespace)
                .filter(|value| !value.is_empty())
                .unwrap_or("application/octet-stream");
            let size = attachment
                .size_bytes
                .filter(|value| value.is_finite())
                .map_or_else(
                    || "unknown size".into(),
                    |value| format!("{} bytes", number(value)),
                );
            format!(
                "- {name} ({}, {mime}, {size}, attachment_id: {})",
                attachment_kind(&attachment.kind),
                attachment.id
            )
        })
        .collect::<Vec<_>>();
    (!lines.is_empty()).then(|| {
        section(
            "current-attachments",
            "Current Attachment References",
            lines.join("\n"),
            "working_context",
            "optional_hot_cache",
            if binding.project_id.is_some() {
                "project"
            } else {
                "session"
            },
        )
    })
}

pub(super) fn attachment_references(request: &TurnRequest) -> Vec<Value> {
    request
        .message
        .attachments
        .iter()
        .filter(|attachment| !attachment.id.is_empty())
        .take(12)
        .map(|attachment| {
            let mut metadata = Map::new();
            metadata.insert("kind".into(), attachment_kind(&attachment.kind).into());
            if let Some(value) = &attachment.mime_type {
                metadata.insert("mimeType".into(), value.clone().into());
            }
            if let Some(value) = attachment.size_bytes {
                metadata.insert(
                    "sizeBytes".into(),
                    serde_json::Number::from_f64(value)
                        .map(Value::Number)
                        .unwrap_or(Value::Null),
                );
            }
            let mut reference = Map::new();
            reference.insert("kind".into(), "attachment".into());
            reference.insert("id".into(), attachment.id.clone().into());
            if let Some(value) = &attachment.file_name {
                reference.insert("label".into(), value.clone().into());
            }
            reference.insert("metadata".into(), Value::Object(metadata));
            Value::Object(reference)
        })
        .collect()
}

pub(super) fn section(
    id: &str,
    title: &str,
    content: String,
    region: &str,
    projection: &str,
    scope: &str,
) -> ContextSection {
    ContextSection {
        id: id.into(),
        title: title.into(),
        content,
        region: Some(region.into()),
        projection_class: projection.into(),
        scope_kind: scope.into(),
        source: None,
    }
}

fn best_geo_hint(
    user: Option<&Map<String, Value>>,
    environment: Option<&str>,
    timezone: &str,
) -> String {
    let environment = environment.map(safe_config_string).unwrap_or_default();
    if !environment.is_empty() {
        return environment;
    }
    for key in ["location", "geo"] {
        let value = stringify_geo(user.and_then(|value| value.get(key)));
        if !value.is_empty() {
            return value;
        }
    }
    format!("Not configured; timezone hint only: {timezone}")
}

fn stringify_geo(value: Option<&Value>) -> String {
    if let Some(value) = value.and_then(Value::as_str) {
        return safe_config_string(value);
    }
    let Some(value) = value.and_then(Value::as_object) else {
        return String::new();
    };
    ["city", "region", "country", "countryCode"]
        .iter()
        .map(|key| safe_config_text(value.get(*key)))
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join(", ")
}

fn role_text(role: &SessionRole) -> &str {
    match role {
        SessionRole::Butler => "butler",
        SessionRole::Steward => "steward",
        SessionRole::Worker => "worker",
        SessionRole::Unknown(value) => value,
    }
}
fn project_status_text(status: ProjectCapsuleStatus) -> &'static str {
    match status {
        ProjectCapsuleStatus::Skipped => "skipped",
        ProjectCapsuleStatus::Present => "present",
        ProjectCapsuleStatus::Missing => "missing",
    }
}
fn attachment_kind(kind: &AttachmentKind) -> &'static str {
    match kind {
        AttachmentKind::Image => "image",
        AttachmentKind::Audio => "audio",
        AttachmentKind::Video => "video",
        AttachmentKind::Document => "document",
        AttachmentKind::Binary => "binary",
    }
}
fn number(value: f64) -> String {
    serde_json::Number::from_f64(value)
        .map(Value::Number)
        .and_then(|value| crate::json::stringify(&value).ok())
        .unwrap_or_else(|| value.to_string())
}
