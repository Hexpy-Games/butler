//! Wire projections retain exact approval text; unknown wire kinds remain visible.
use super::super::{
    ActivityItem, Approval, AuthorityCard, CardKind, ChatId, ChatRef, ChatSummary, EventCursor,
    Message, MessageCursor, MessagePage, RequestRef, Risk, Role, SessionId, SourceError, Space,
    Timestamp, TurnId,
    model::{Access, Operation, Target, ToolChip},
};
use butler_shell_client::{AuthorityPage, Error};
use serde_json::Value;

pub(super) fn error(error: &Error) -> SourceError {
    match error.kind() {
        butler_shell_client::FailureKind::Disconnected => SourceError::Disconnected,
        butler_shell_client::FailureKind::Incompatible => SourceError::Incompatible,
        butler_shell_client::FailureKind::Missing => SourceError::Missing,
        _ => SourceError::Refused(error.to_string()),
    }
}
pub(super) fn string<'a>(raw: &'a Value, key: &str) -> Result<&'a str, Error> {
    raw[key].as_str().ok_or(Error::Protocol)
}
fn strings(raw: &Value) -> Vec<gpui::SharedString> {
    raw.as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|s| s.to_owned().into())
        .collect()
}
pub(super) fn identity(raw: &Value) -> Result<ChatRef, Error> {
    let id = string(raw, "id")?.to_owned();
    Ok(ChatRef {
        chat: ChatId(id.clone().into()),
        session: SessionId(id.into()),
    })
}
pub(super) fn chat(raw: &Value) -> Result<ChatSummary, Error> {
    let updated = string(raw, "updated_at")?;
    let updated = chrono::DateTime::parse_from_rfc3339(updated).map_err(|_| Error::Protocol)?;
    let project = raw.get("project").filter(|v| v.is_object());
    Ok(ChatSummary {
        chat: identity(raw)?,
        title: string(raw, "title")?.to_owned().into(),
        space: project.map(|p| Space {
            id: p["id"].as_str().unwrap_or_default().to_owned().into(),
            title: p["display_name"]
                .as_str()
                .unwrap_or_default()
                .to_owned()
                .into(),
            project: true,
        }),
        pinned: raw["pinned"].as_bool().unwrap_or(false),
        archived: raw["archived"].as_bool().unwrap_or(false),
        created_at: Timestamp(
            chrono::DateTime::parse_from_rfc3339(string(raw, "created_at")?)
                .map_err(|_| Error::Protocol)?
                .timestamp_millis(),
        ),
        running: raw["active_turn_state"].as_str().is_some_and(active),
        updated_at: Timestamp(updated.timestamp_millis()),
    })
}
pub(super) fn active(state: &str) -> bool {
    !matches!(
        state,
        "delivered" | "failed" | "cancelled" | "completed" | "runtime_fault"
    )
}
pub(super) fn message(raw: &Value) -> Result<Message, Error> {
    let role = match string(raw, "role")? {
        "user" => Role::User,
        "assistant" => Role::Assistant,
        other => Role::Other(other.to_owned()),
    };
    Ok(Message {
        id: string(raw, "id")?.to_owned().into(),
        role,
        text: string(raw, "text")?.to_owned(),
        activity: activity(raw),
        streaming: matches!(
            raw["status"].as_str(),
            Some("streaming" | "draft" | "provisional")
        ),
    })
}
pub(super) fn window(raw: &Value) -> Result<MessagePage, Error> {
    let rows = raw["messages"].as_array().ok_or(Error::Protocol)?;
    Ok(MessagePage {
        messages: rows.iter().map(message).collect::<Result<_, _>>()?,
        older: raw["message_window"]["previous_cursor_token"]
            .as_str()
            .map(|s| MessageCursor(s.into())),
        running: raw["active_turn"]["id"]
            .as_str()
            .map(|s| TurnId(s.to_owned().into())),
        events: EventCursor(raw["cursors"]["events"].as_u64().ok_or(Error::Protocol)?),
    })
}
pub(super) fn authority(page: AuthorityPage) -> Result<Vec<AuthorityCard>, Error> {
    page.requests
        .into_iter()
        .map(|card| {
            let kind = match card.raw["category"].as_str().unwrap_or_default() {
                "command" => CardKind::Command,
                "reviewed_effect" => CardKind::ReviewedEffect,
                "ask_user" => CardKind::Question,
                name => CardKind::Other(name.to_owned().into()),
            };
            Ok(AuthorityCard {
                request: RequestRef(card.request_ref.into()),
                kind,
                reason: card.reason.into(),
                approval: if card.approval.is_null() {
                    None
                } else {
                    Some(approval(&card.approval)?)
                },
            })
        })
        .collect()
}
fn approval(raw: &Value) -> Result<Approval, Error> {
    let operation = raw
        .get("operation")
        .filter(|v| v.is_object())
        .map(|o| {
            Ok(Operation {
                tool: string(o, "tool")?.to_owned().into(),
                access: match string(o, "access")? {
                    "read_only" => Access::ReadOnly,
                    _ => Access::Change,
                },
                targets: strings(&o["targets"]),
                command: o["command"].as_str().map(|s| s.to_owned().into()),
            })
        })
        .transpose()?;
    let targets = raw["targets"]
        .as_array()
        .ok_or(Error::Protocol)?
        .iter()
        .map(|t| {
            Ok(Target {
                kind: string(t, "kind")?.to_owned().into(),
                path: string(t, "path")?.to_owned().into(),
                label: None,
            })
        })
        .collect::<Result<_, Error>>()?;
    Ok(Approval {
        wire: Some(raw.clone()),
        action_kind: string(raw, "action_kind")?.to_owned().into(),
        operation,
        targets,
        count: raw["count"]
            .as_u64()
            .and_then(|c| u32::try_from(c).ok())
            .ok_or(Error::Protocol)?,
        examples: strings(&raw["examples"]),
        examples_truncated: raw["examples_truncated"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|v| v.as_bool().unwrap_or(false))
            .collect(),
        risk: match raw["risk"].as_str() {
            Some("low") => Some(Risk::Low),
            Some("medium") => Some(Risk::Medium),
            Some("high") => Some(Risk::High),
            _ => None,
        },
    })
}

/// The gateway's public activity groups, with complete tool input labels.
fn activity(raw: &Value) -> Vec<ActivityItem> {
    raw["work_blocks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|block| {
            let title = block["label"].as_str()?.to_owned().into();
            let tools = block["rows"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|row| {
                    let name = row["safe_tool_name"].as_str()?;
                    let label = row["safe_input_label"].as_str().unwrap_or(name);
                    Some(ToolChip {
                        icon: "wrench",
                        title: label.to_owned().into(),
                    })
                })
                .collect();
            Some(ActivityItem { title, tools })
        })
        .collect()
}
