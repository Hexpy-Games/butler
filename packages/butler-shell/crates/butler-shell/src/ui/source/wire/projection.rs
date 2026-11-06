//! Compatibility projections for the fields the current shell consumes.
//! Full renderer contracts live alongside these. Optional projection fields also
//! tolerate wrong JSON types, matching the existing Value::as_* fallbacks.
use serde::{Deserialize, Deserializer, de::DeserializeOwned};
use serde_json::Value;

fn optional<'de, D: Deserializer<'de>, T: DeserializeOwned>(d: D) -> Result<Option<T>, D::Error> {
    Ok(serde_json::from_value(Value::deserialize(d)?).ok())
}
fn list<'de, D: Deserializer<'de>, T: DeserializeOwned>(d: D) -> Result<Vec<T>, D::Error> {
    let value = Value::deserialize(d)?;
    Ok(value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| serde_json::from_value(item.clone()).ok())
        .collect())
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
fn object_list<'de, D: Deserializer<'de>, T: DeserializeOwned>(d: D) -> Result<Vec<T>, D::Error> {
    let values = Vec::<Value>::deserialize(d)?;
    values
        .into_iter()
        .map(|v| {
            if !v.is_object() {
                return Err(serde::de::Error::custom("expected object"));
            }
            serde_json::from_value(v).map_err(serde::de::Error::custom)
        })
        .collect()
}
fn optional_object_list<'de, D: Deserializer<'de>, T: DeserializeOwned>(
    d: D,
) -> Result<Vec<T>, D::Error> {
    let value = Value::deserialize(d)?;
    Ok(value
        .as_array()
        .into_iter()
        .flatten()
        .filter(|v| v.is_object())
        .filter_map(|v| serde_json::from_value(v.clone()).ok())
        .collect())
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
    pub(crate) id: Option<String>,
    #[serde(default, deserialize_with = "optional")]
    pub(crate) role: Option<String>,
    #[serde(default, deserialize_with = "optional")]
    pub(crate) text: Option<String>,
    #[serde(default, deserialize_with = "optional")]
    pub(crate) status: Option<String>,
    #[serde(default, deserialize_with = "optional")]
    pub(crate) chat_id: Option<String>,
    #[serde(default, deserialize_with = "optional_object_list")]
    pub(crate) work_blocks: Vec<WorkProjection>,
}
/// TS: packages/butler-app/client/ui/src/app/types.ts:1340 WorkBlockView (consumed fields).
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct WorkProjection {
    #[serde(default, deserialize_with = "optional")]
    pub(crate) label: Option<String>,
    #[serde(default, deserialize_with = "optional_object_list")]
    pub(crate) rows: Vec<ToolProjection>,
}
/// TS: packages/butler-app/client/ui/src/app/types.ts:1023 ProgressRow (consumed fields).
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct ToolProjection {
    #[serde(default, deserialize_with = "optional")]
    pub(crate) safe_tool_name: Option<String>,
    #[serde(default, deserialize_with = "optional")]
    pub(crate) safe_input_label: Option<String>,
}
/// TS: packages/butler-app/client/ui/src/app/types.ts:1263 SessionView (consumed fields).
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct WindowProjection {
    #[serde(deserialize_with = "object_list")]
    pub(crate) messages: Vec<MessageProjection>,
    #[serde(default, deserialize_with = "optional_object")]
    pub(crate) message_window: Option<WindowCursorProjection>,
    #[serde(default, deserialize_with = "optional_object")]
    pub(crate) active_turn: Option<TurnProjection>,
    #[serde(deserialize_with = "object")]
    pub(crate) cursors: CursorsProjection,
}
/// TS: packages/butler-app/client/ui/src/app/types.ts:1141 SessionViewMessageWindow (consumed fields).
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct WindowCursorProjection {
    #[serde(default, deserialize_with = "optional")]
    pub(crate) previous_cursor_token: Option<String>,
}
/// TS: packages/butler-app/client/ui/src/app/types.ts:1160 SessionViewCursors (consumed fields).
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct CursorsProjection {
    pub(crate) events: u64,
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
/// Gateway snake_case approval facts before the renderer's ApprovalSummary normalization.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct ApprovalProjection {
    pub(crate) action_kind: String,
    #[serde(default, deserialize_with = "optional_object")]
    pub(crate) operation: Option<OperationProjection>,
    #[serde(deserialize_with = "object_list")]
    pub(crate) targets: Vec<TargetProjection>,
    pub(crate) count: u64,
    #[serde(default, deserialize_with = "list")]
    pub(crate) examples: Vec<String>,
    #[serde(default, deserialize_with = "list")]
    pub(crate) examples_truncated: Vec<Value>,
    #[serde(default, deserialize_with = "optional")]
    pub(crate) risk: Option<String>,
}
/// Gateway operation facts consumed by the current approval card.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct OperationProjection {
    #[serde(default, deserialize_with = "optional")]
    pub(crate) tool: Option<String>,
    #[serde(default, deserialize_with = "optional")]
    pub(crate) access: Option<String>,
    #[serde(default, deserialize_with = "list")]
    pub(crate) targets: Vec<String>,
    #[serde(default, deserialize_with = "optional")]
    pub(crate) command: Option<String>,
}
/// Gateway approval target facts consumed by the current approval card.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct TargetProjection {
    pub(crate) kind: String,
    pub(crate) path: String,
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
