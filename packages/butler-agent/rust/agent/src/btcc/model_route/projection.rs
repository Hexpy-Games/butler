use serde_json::{Map, Value, json};

use crate::btcc::{AgentLoopProgress, RuntimeTurnEventInput, TurnSemanticState};

use super::execution::ViewState;

pub(super) async fn fallback(
    progress: &dyn AgentLoopProgress,
    state: TurnSemanticState,
    view: &ViewState,
    turn_id: &str,
    round_id: &str,
    candidate: u32,
    model_ref: &str,
) {
    let summary = "대체 모델 경로로 계속 진행합니다.";
    let mut event = RuntimeTurnEventInput::new("assistant.public_note");
    event.payload = json!({
        "note": summary,
        "btccState": state_text(state),
        "decisionTitle": "대체 모델 경로 선택",
        "decisionSummary": summary,
        "decisionSource": "model-authored",
        "semanticBlockId": format!("{turn_id}:model-fallback:{round_id}:{candidate}"),
        "originTurnId": turn_id,
        "sourceRevision": view.next_source_revision(),
        "model": model_ref,
    })
    .as_object()
    .cloned();
    let _ = progress.emit(event).await;
}

pub(super) async fn fallback_started(
    progress: &dyn AgentLoopProgress,
    round_id: &str,
    model_ref: &str,
) {
    let mut iteration = RuntimeTurnEventInput::new("turn.iteration.started");
    iteration.payload = json!({
        "model": model_ref, "modelRef": model_ref, "requestId": round_id,
    })
    .as_object()
    .cloned();
    let _ = progress.emit(iteration).await;

    let mut event = RuntimeTurnEventInput::new("tool.started");
    event.payload = Some(Map::from_iter([
        (
            "safeLabel".into(),
            Value::String("Generating response".into()),
        ),
        (
            "interfaceLabelKey".into(),
            Value::String("generating".into()),
        ),
        ("toolName".into(), Value::String("model_round".into())),
        ("toolCallId".into(), Value::String(round_id.into())),
        ("activityKind".into(), Value::String("message".into())),
        (
            "bridgePhase".into(),
            Value::String("model_round_waiting".into()),
        ),
        ("model".into(), Value::String(model_ref.into())),
        ("modelRef".into(), Value::String(model_ref.into())),
    ]));
    let _ = progress.emit(event).await;
}

pub(super) async fn recovery(
    progress: &dyn AgentLoopProgress,
    state: TurnSemanticState,
    status: &str,
    attempt: u32,
    max_attempts: u32,
) {
    let state = state_text(state);
    let payload = if status == "cleared" {
        json!({
            "note": if state == "admitted" { "Request accepted." } else { "Working" },
            "interfaceLabelKey": if state == "admitted" { "accepted" } else { "working" },
            "btccState": state,
            "semanticBlockId": state,
            "bridgePhase": "operational_recovery",
            "recoveryStatus": status,
        })
    } else {
        json!({
            "note": format!("Reconnecting ({attempt}/{max_attempts})"),
            "btccState": state,
            "operational": true,
            "interfaceLabelParameters": {"attempt":attempt,"maxAttempts":max_attempts},
            "interfaceLabelKey": "reconnecting",
            "semanticBlockId": state,
            "bridgePhase": "operational_recovery",
            "recoveryStatus": status,
        })
    };
    let mut event = RuntimeTurnEventInput::new("assistant.public_note");
    event.payload = payload.as_object().cloned();
    let _ = progress.emit(event).await;
}

fn state_text(state: TurnSemanticState) -> &'static str {
    match state {
        TurnSemanticState::Admitted => "admitted",
        TurnSemanticState::DeliveryCommitted => "delivery_committed",
        TurnSemanticState::Delivered => "delivered",
        TurnSemanticState::Cancelled => "cancelled",
    }
}
