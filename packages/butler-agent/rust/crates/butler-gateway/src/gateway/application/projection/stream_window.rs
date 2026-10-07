//! Only disposable text deltas can be acknowledged before the timed commit.
use super::AppWorkStreamTurnOutcome;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::gateway::application) struct TranscriptEvent {
    pub event_id: String,
    pub session_id: String,
    pub kind: String,
    pub timestamp: String,
    pub payload: Map<String, Value>,
    #[serde(default)]
    pub transport: Option<String>,
    #[serde(default)]
    pub metadata: Option<Map<String, Value>>,
}

pub(super) fn stream_delta(event: &TranscriptEvent) -> bool {
    event
        .payload
        .get("metadata")
        .and_then(|metadata| metadata.get("kind"))
        .and_then(Value::as_str)
        == Some("turn_event")
        && matches!(
            event
                .payload
                .get("metadata")
                .and_then(|value| value.pointer("/event/kind"))
                .and_then(serde_json::Value::as_str),
            Some("model.stream.text_delta" | "model.stream.reasoning_delta")
        )
}
pub(super) fn projected_work_outcome(
    _chat_id: &str,
    event: &TranscriptEvent,
) -> Option<AppWorkStreamTurnOutcome> {
    let metadata = event.payload.get("metadata")?.as_object()?;
    let kind = metadata.get("kind")?.as_str()?;
    let (outcome, status_note) = match kind {
        "turn_failed" => ("failed", "Reconciled after failed turn replay."),
        "turn_cancelled" => ("cancelled", "Reconciled after cancelled turn replay."),
        _ => return None,
    };
    Some(AppWorkStreamTurnOutcome {
        session_id: event.session_id.clone(),
        turn_id: metadata.get("turnId")?.as_str()?.to_owned(),
        outcome: outcome.into(),
        status_note: status_note.into(),
    })
}
