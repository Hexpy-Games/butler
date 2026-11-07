//! Compatibility projections for the fields the current shell consumes.
//! Full renderer contracts live alongside these. Optional projection fields also
//! tolerate wrong JSON types, matching the existing Value::as_* fallbacks.
use serde::{Deserialize, Deserializer, de::DeserializeOwned};
use serde_json::Value;

fn optional<'de, D: Deserializer<'de>, T: DeserializeOwned>(d: D) -> Result<Option<T>, D::Error> {
    Ok(serde_json::from_value(Value::deserialize(d)?).ok())
}
fn object<'de, D: Deserializer<'de>, T: DeserializeOwned>(d: D) -> Result<T, D::Error> {
    let value = Value::deserialize(d)?;
    if !value.is_object() {
        return Err(serde::de::Error::custom("expected object"));
    }
    serde_json::from_value(value).map_err(serde::de::Error::custom)
}
fn optional_object<'de, D: Deserializer<'de>, T: DeserializeOwned>(
    d: D,
) -> Result<Option<T>, D::Error> {
    let value = Value::deserialize(d)?;
    Ok(value
        .is_object()
        .then(|| serde_json::from_value(value).ok())
        .flatten())
}
/// JSON field presence, retaining explicit null or malformed values separately from omission.
#[derive(Debug, Clone, Default)]
pub(crate) enum Field<T> {
    #[default]
    Missing,
    Present(Option<T>),
}
fn present<'de, D: Deserializer<'de>, T: DeserializeOwned>(d: D) -> Result<Field<T>, D::Error> {
    Ok(Field::Present(optional_object(d)?))
}

/// TS: packages/butler-app/client/shared/message-session-contracts.ts:154 SessionSummary (consumed fields).
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct ChatProjection {
    #[serde(default, deserialize_with = "optional")]
    pub(crate) id: Option<String>,
    #[serde(default, deserialize_with = "optional")]
    pub(crate) title: Option<String>,
    #[serde(default, deserialize_with = "optional")]
    pub(crate) created_at: Option<String>,
    #[serde(default, deserialize_with = "optional")]
    pub(crate) updated_at: Option<String>,
    #[serde(default, deserialize_with = "optional")]
    pub(crate) active_turn_state: Option<String>,
    #[serde(default, deserialize_with = "optional")]
    pub(crate) attention_required: Option<bool>,
    #[serde(default, deserialize_with = "optional_object")]
    pub(crate) project: Option<ProjectProjection>,
    #[serde(default, deserialize_with = "optional")]
    pub(crate) pinned: Option<bool>,
    #[serde(default, deserialize_with = "optional")]
    pub(crate) archived: Option<bool>,
}
/// TS: packages/butler-app/client/shared/message-session-contracts.ts:154 SessionSummary.project.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct ProjectProjection {
    #[serde(default, deserialize_with = "optional")]
    pub(crate) id: Option<String>,
    #[serde(default, deserialize_with = "optional")]
    pub(crate) display_name: Option<String>,
}
/// TS: packages/butler-app/client/ui/src/app/types.ts:912 MessageRecord (consumed fields).
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct MessageProjection {
    #[serde(default, deserialize_with = "optional")]
    pub(crate) role: Option<String>,
    #[serde(default, deserialize_with = "optional")]
    pub(crate) status: Option<String>,
    #[serde(default, deserialize_with = "optional")]
    pub(crate) chat_id: Option<String>,
}
/// TS: packages/butler-app/client/ui/src/app/types.ts:1787 TimelineEvent.payload.turn (consumed fields).
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct TurnProjection {
    #[serde(default, deserialize_with = "optional")]
    pub(crate) id: Option<String>,
    #[serde(default, deserialize_with = "optional")]
    pub(crate) turn_id: Option<String>,
    #[serde(default, deserialize_with = "optional")]
    pub(crate) chat_id: Option<String>,
    #[serde(default, deserialize_with = "optional")]
    pub(crate) state: Option<String>,
}
/// TS: packages/butler-app/client/ui/src/app/types.ts:1787 TimelineEvent (consumed fields).
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct EventProjection {
    pub(crate) r#type: String,
    #[serde(default, deserialize_with = "optional_object")]
    pub(crate) payload: Option<EventPayloadProjection>,
}
/// TS: packages/butler-app/client/ui/src/app/types.ts:1787 TimelineEvent.payload (consumed fields).
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct EventPayloadProjection {
    #[serde(default, deserialize_with = "optional_object")]
    pub(crate) message: Option<MessageProjection>,
    #[serde(default, deserialize_with = "optional_object")]
    pub(crate) session: Option<ChatProjection>,
    #[serde(default, deserialize_with = "optional")]
    pub(crate) chat_id: Option<String>,
    #[serde(default, deserialize_with = "optional")]
    pub(crate) session_id: Option<String>,
    #[serde(default, deserialize_with = "optional")]
    pub(crate) message_id: Option<String>,
    #[serde(default, deserialize_with = "optional")]
    pub(crate) turn_id: Option<String>,
    #[serde(default, deserialize_with = "optional")]
    pub(crate) id: Option<String>,
    #[serde(default, deserialize_with = "optional")]
    pub(crate) state: Option<String>,
    #[serde(default, deserialize_with = "present")]
    pub(crate) turn: Field<TurnProjection>,
}
/// TS: packages/butler-app/client/ui/src/app/types.ts:813 CreateSessionResult (consumed fields).
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct CreatedSessionProjection {
    #[serde(deserialize_with = "object")]
    pub(crate) session: ChatProjection,
}
/// Gateway post-message response; supports both the top-level and nested turn identity.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct SentTurnProjection {
    #[serde(default, deserialize_with = "optional")]
    pub(crate) turn_id: Option<String>,
    #[serde(default, deserialize_with = "optional_object")]
    pub(crate) turn: Option<TurnProjection>,
}
/// Gateway authority request category (the TS transport deliberately leaves requests unknown).
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct AuthorityProjection {
    #[serde(default, deserialize_with = "optional")]
    pub(crate) category: Option<String>,
}
/// TS: packages/butler-app/client/ui/src/app/types.ts:753 SessionControlsView (consumed fields).
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct ControlsProjection {
    #[serde(deserialize_with = "object")]
    pub(crate) controls: ControlLabelsProjection,
}
/// TS: packages/butler-app/client/ui/src/app/types.ts:746 SessionControlState (labels remain open strings).
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct ControlLabelsProjection {
    pub(crate) access_mode: String,
    pub(crate) model: String,
    pub(crate) reasoning_effort: String,
}

/// GET /settings fields consumed by the app frame.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct FrameSettings {
    pub(crate) desktop_notifications: DesktopNotifications,
}
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct DesktopNotifications {
    pub(crate) enabled: bool,
}
