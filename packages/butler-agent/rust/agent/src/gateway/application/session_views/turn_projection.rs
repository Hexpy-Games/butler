use serde::Serialize;
use serde_json::Value;

use super::super::{AppApplication, GatewayApplicationError};
use crate::btcc::{ControlSource, ExecutionControls, ReasoningEffort, SubsessionResultContext};
use crate::gateway::{DeliveryState, TurnProgressSnapshotView, TurnRecord, TurnState};

#[derive(Clone, Serialize)]
pub(super) struct SessionViewTurnProjection {
    id: String,
    state: TurnState,
    delivery_state: DeliveryState,
    limitations: Vec<String>,
    limitation_codes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    safe_status_label: Option<String>,
    cancellable: bool,
    retryable: bool,
    progress: TurnProgressSnapshotView,
    created_at: String,
    updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    execution_controls: Option<SessionViewExecutionControls>,
    #[serde(skip_serializing_if = "Option::is_none")]
    execution_model: Option<SessionViewExecutionModel>,
}

#[derive(Clone, Serialize)]
struct SessionViewExecutionControls {
    model_ref: String,
    reasoning_effort: ReasoningEffort,
    source: ControlSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    subsession_result: Option<SubsessionResultContext>,
}

#[derive(Clone, Serialize)]
struct SessionViewExecutionModel {
    requested_model_ref: String,
    adapter_effective_model_ref: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_reported_model_ref: Option<String>,
}

pub(super) async fn read_latest(
    app: &AppApplication,
    chat_id: String,
) -> Result<Option<(TurnRecord, TurnProgressSnapshotView)>, GatewayApplicationError> {
    app.storage
        .execute(move |db| {
            let Some(turn) = super::super::read_model::latest_turn(db, &chat_id)? else {
                return Ok(None);
            };
            let progress = super::super::progress_view::read(db, &turn.id)?.ok_or_else(|| {
                super::super::storage::AppStorageError::new(
                    "app_projection_missing",
                    "Turn progress is unavailable.",
                )
            })?;
            Ok(Some((turn, progress)))
        })
        .await
        .map_err(super::super::app_error)
}

pub(super) fn project(
    turn: &TurnRecord,
    mut progress: TurnProgressSnapshotView,
    chat_id: &str,
    suppress_progress_rows: bool,
) -> Result<SessionViewTurnProjection, GatewayApplicationError> {
    if suppress_progress_rows {
        progress.safe_progress_rows.clear();
    }
    let safe_status_label = if matches!(
        &turn.state,
        &TurnState::Retrying | &TurnState::WaitingForTool
    ) {
        None
    } else {
        progress.summary.clone()
    };
    progress.summary = safe_status_label.clone();
    if progress.turn_id.as_deref() != Some(turn.id.as_str())
        || progress.updated_at.is_none()
        || progress.state.is_none()
        || progress.delivery_state.is_none()
    {
        return Err(GatewayApplicationError::Internal);
    }
    let delivery_state = progress
        .delivery_state
        .clone()
        .ok_or(GatewayApplicationError::Internal)?;
    let execution_controls = public_execution_controls(turn, chat_id);
    let execution_model = public_execution_model(turn.execution_model.as_ref());
    Ok(SessionViewTurnProjection {
        id: turn.id.clone(),
        state: turn.state.clone(),
        delivery_state,
        limitations: progress.limitations.clone().unwrap_or_default(),
        limitation_codes: progress.limitation_codes.clone().unwrap_or_default(),
        safe_status_label,
        cancellable: turn.cancellable,
        retryable: turn.retryable,
        progress,
        created_at: turn.created_at.clone(),
        updated_at: turn.updated_at.clone(),
        execution_controls,
        execution_model,
    })
}

fn public_execution_controls(
    turn: &TurnRecord,
    chat_id: &str,
) -> Option<SessionViewExecutionControls> {
    let raw = turn.execution_controls.clone()?;
    let controls = serde_json::from_value::<ExecutionControls>(raw).ok()?;
    let verified = controls.verify().ok()?;
    if verified.turn_id != turn.id || verified.session_id != chat_id {
        return None;
    }
    Some(SessionViewExecutionControls {
        model_ref: verified.model_ref,
        reasoning_effort: verified.reasoning_effort,
        source: verified.source,
        subsession_result: verified.subsession_result,
    })
}

fn public_execution_model(value: Option<&Value>) -> Option<SessionViewExecutionModel> {
    let value = value?.as_object()?;
    Some(SessionViewExecutionModel {
        requested_model_ref: value.get("requested_model_ref")?.as_str()?.to_owned(),
        adapter_effective_model_ref: value
            .get("adapter_effective_model_ref")?
            .as_str()?
            .to_owned(),
        provider_reported_model_ref: value
            .get("provider_reported_model_ref")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}
