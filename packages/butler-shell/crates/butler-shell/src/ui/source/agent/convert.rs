//! Wire projections retain exact approval text; unknown wire kinds remain visible.
use super::super::wire;
use super::super::{
    Approval, AuthorityCard, ChatId, ChatRef, ChatSummary, RequestRef, Risk, SessionId,
    SourceError, Space, Timestamp,
    model::{Access, Operation, Target},
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
pub(super) fn decode<T: serde::de::DeserializeOwned>(raw: &Value) -> Result<T, Error> {
    if !raw.is_object() {
        return Err(Error::Protocol);
    }
    serde_json::from_value(raw.clone()).map_err(|_| Error::Protocol)
}
pub(super) fn identity(raw: &wire::ChatProjection) -> Result<ChatRef, Error> {
    let id = raw.id.as_deref().ok_or(Error::Protocol)?;
    Ok(ChatRef {
        chat: ChatId(id.to_owned().into()),
        session: SessionId(id.to_owned().into()),
    })
}
pub(super) fn chat(raw: &Value) -> Result<ChatSummary, Error> {
    chat_row(&decode::<wire::ChatProjection>(raw)?)
}
pub(super) fn chat_row(raw: &wire::ChatProjection) -> Result<ChatSummary, Error> {
    let updated = raw.updated_at.as_deref().ok_or(Error::Protocol)?;
    let updated = chrono::DateTime::parse_from_rfc3339(updated).map_err(|_| Error::Protocol)?;
    Ok(ChatSummary {
        chat: identity(raw)?,
        title: raw.title.clone().ok_or(Error::Protocol)?.into(),
        space: raw.project.as_ref().map(|p| Space {
            id: p.id.clone().unwrap_or_default().into(),
            title: p.display_name.clone().unwrap_or_default().into(),
            project: true,
        }),
        pinned: raw.pinned.unwrap_or(false),
        archived: raw.archived.unwrap_or(false),
        created_at: Timestamp(
            chrono::DateTime::parse_from_rfc3339(raw.created_at.as_deref().ok_or(Error::Protocol)?)
                .map_err(|_| Error::Protocol)?
                .timestamp_millis(),
        ),
        running: raw.active_turn_state.as_deref().is_some_and(active),
        waiting: raw.attention_required.unwrap_or(false)
            || raw.active_turn_state.as_deref() == Some("waiting_for_form"),
        updated_at: Timestamp(updated.timestamp_millis()),
    })
}
pub(super) fn active(state: &str) -> bool {
    !matches!(
        state,
        "delivered" | "failed" | "cancelled" | "completed" | "runtime_fault"
    )
}
pub(super) fn authority(page: AuthorityPage) -> Result<Vec<AuthorityCard>, Error> {
    page.requests
        .into_iter()
        .map(|card| {
            Ok(AuthorityCard {
                request: RequestRef(card.request_ref.into()),
                approval: if card.approval.is_null() {
                    None
                } else {
                    Some(approval(&card.approval)?)
                },
            })
        })
        .collect()
}
fn approval(value: &Value) -> Result<Approval, Error> {
    let raw = decode::<wire::ApprovalProjection>(value)?;
    let operation = raw
        .operation
        .map(|o| {
            Ok(Operation {
                tool: o.tool.ok_or(Error::Protocol)?.into(),
                access: match o.access.as_deref().ok_or(Error::Protocol)? {
                    "read_only" => Access::ReadOnly,
                    _ => Access::Change,
                },
                targets: o.targets.into_iter().map(Into::into).collect(),
                command: o.command.map(Into::into),
            })
        })
        .transpose()?;
    Ok(Approval {
        wire: Some(value.clone()),
        action_kind: raw.action_kind.into(),
        operation,
        targets: raw
            .targets
            .into_iter()
            .map(|t| Target {
                kind: t.kind.into(),
                path: t.path.into(),
                label: None,
            })
            .collect(),
        count: u32::try_from(raw.count).map_err(|_| Error::Protocol)?,
        examples: raw.examples.into_iter().map(Into::into).collect(),
        examples_truncated: raw
            .examples_truncated
            .into_iter()
            .map(|v| v.as_bool().unwrap_or(false))
            .collect(),
        risk: match raw.risk.as_deref() {
            Some("low") => Some(Risk::Low),
            Some("medium") => Some(Risk::Medium),
            Some("high") => Some(Risk::High),
            _ => None,
        },
    })
}
