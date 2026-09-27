//! Runtime progress vocabulary shared by Conversation and durable publication.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::{ProgressEvent, TurnSemanticState};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeTurnEventInput {
    pub(crate) kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) session_sequence: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) turn_sequence: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) visibility: Option<EventVisibility>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) payload: Option<Map<String, Value>>,
    #[serde(flatten)]
    pub(crate) extensions: Map<String, Value>,
}

impl RuntimeTurnEventInput {
    pub(crate) fn new(kind: impl Into<String>) -> Self {
        Self {
            kind: kind.into(),
            id: None,
            session_sequence: None,
            turn_sequence: None,
            created_at: None,
            visibility: None,
            payload: None,
            extensions: Map::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum EventVisibility {
    Public,
    Internal,
}

pub(super) fn project(event: ProgressEvent) -> RuntimeTurnEventInput {
    match event {
        ProgressEvent::Started => RuntimeTurnEventInput::new("turn.started"),
        ProgressEvent::Cancelled
        | ProgressEvent::StateChanged {
            semantic_state: TurnSemanticState::Cancelled,
            ..
        } => RuntimeTurnEventInput::new("turn.cancelled"),
        ProgressEvent::StateChanged {
            semantic_state: TurnSemanticState::DeliveryCommitted,
            ..
        } => RuntimeTurnEventInput::new("message.final.started"),
        ProgressEvent::StateChanged {
            semantic_state: TurnSemanticState::Delivered,
            ..
        } => RuntimeTurnEventInput::new("turn.completed"),
        ProgressEvent::StateChanged {
            semantic_state: TurnSemanticState::Admitted,
            turn_revision,
        } => {
            let mut event = RuntimeTurnEventInput::new("assistant.public_note");
            // The source calls getAppCopy() without a locale. Its default is
            // en-US; UI localization uses interfaceLabelKey independently.
            event.payload = json!({
                "note": "Request accepted.", "interfaceLabelKey": "accepted",
                "btccState": "admitted", "semanticBlockId": "admitted",
                "turnRevision": turn_revision,
            })
            .as_object()
            .cloned();
            event
        }
    }
}
