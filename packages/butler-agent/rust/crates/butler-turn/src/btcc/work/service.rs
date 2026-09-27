//! Validation and policy precede repository admission; repository owns durable state.

mod closeout;
mod progress;
mod relation;

use std::sync::Arc;

use serde_json::Value;

use crate::btcc::{BtccError, PortFuture};

use super::contracts::*;
use crate::btcc::BtccCode;

/// Durable Work storage; each command is idempotent by its mutation call id.
pub trait DurableWorkRepository: Send + Sync {
    /// The turn's bound Work with its request and results.
    fn load_context(&self, scope: WorkTurnScope) -> PortFuture<'_, Option<WorkContext>>;
    /// Imports the scope's open legacy Work, if any.
    fn import_open_legacy_work(&self, scope: WorkTurnScope)
    -> PortFuture<'_, Option<LegacyImport>>;
    /// Binds the turn to the session's open Work (optionally a specific one).
    fn bind_open_work(
        &self,
        scope: WorkTurnScope,
        expected_work_id: Option<String>,
    ) -> PortFuture<'_, Option<WorkView>>;
    /// Starts new Work for the turn.
    fn start_work(&self, command: StartWorkCommand) -> PortFuture<'_, WorkView>;
    /// Continues existing Work in the turn.
    fn continue_work(&self, command: ContinueWorkCommand) -> PortFuture<'_, WorkView>;
    /// Records a new plan revision.
    fn replace_plan(&self, command: ReplacePlanCommand) -> PortFuture<'_, WorkView>;
    /// Records a progress checkpoint.
    fn record_checkpoint(&self, command: CheckpointCommand) -> PortFuture<'_, WorkView>;
    /// Records a review.
    fn record_review(&self, command: ReviewCommand) -> PortFuture<'_, WorkView>;
    /// Records a disposition.
    fn record_disposition(&self, command: DispositionCommand) -> PortFuture<'_, WorkView>;
    /// Claims the one closeout correction of a turn's Work.
    fn claim_closeout_correction(
        &self,
        input: ClaimCloseoutCorrectionInput,
    ) -> PortFuture<'_, bool>;
    /// The Work bound to a turn.
    fn bound_work_for_turn(&self, turn_id: String) -> PortFuture<'_, Option<WorkView>>;
    /// Abandons the turn's bound open Work.
    fn abandon_bound_work_for_turn(&self, turn_id: String) -> PortFuture<'_, Option<WorkView>>;
}

/// Validates Work commands, fingerprints them for idempotency and applies them.
pub struct DurableWorkService {
    repository: Arc<dyn DurableWorkRepository>,
}

impl DurableWorkService {
    /// A service over the Work repository.
    pub fn new(repository: Arc<dyn DurableWorkRepository>) -> Self {
        Self { repository }
    }

    /// The turn's bound Work context.
    pub async fn load_context(
        &self,
        scope: WorkTurnScope,
    ) -> Result<Option<WorkContext>, BtccError> {
        super::validation::validate_scope(&scope)?;
        self.repository.load_context(scope).await
    }

    pub(crate) async fn import_open_legacy_work(
        &self,
        scope: WorkTurnScope,
    ) -> Result<Option<LegacyImport>, BtccError> {
        super::validation::validate_scope(&scope)?;
        self.repository.import_open_legacy_work(scope).await
    }

    /// Binds the turn to the session's open Work.
    pub async fn bind_open_work(
        &self,
        scope: WorkTurnScope,
        expected_work_id: Option<String>,
    ) -> Result<Option<WorkView>, BtccError> {
        super::validation::validate_scope(&scope)?;
        if let Some(id) = &expected_work_id {
            super::validation::required_text(id, "expectedWorkId")?;
        }
        self.repository
            .bind_open_work(scope, expected_work_id)
            .await
    }

    /// The Work bound to a turn.
    pub async fn bound_work_for_turn(
        &self,
        turn_id: String,
    ) -> Result<Option<WorkView>, BtccError> {
        super::validation::required_text(&turn_id, "turnId")?;
        self.repository.bound_work_for_turn(turn_id).await
    }

    pub(crate) async fn abandon_bound_work_for_turn(
        &self,
        turn_id: String,
    ) -> Result<Option<WorkView>, BtccError> {
        super::validation::required_text(&turn_id, "turnId")?;
        self.repository.abandon_bound_work_for_turn(turn_id).await
    }
}

fn fingerprint(operation: &str, input: &Value) -> Result<String, BtccError> {
    let value = serde_json::json!({"operation": operation, "input": input});
    Ok(crate::btcc::identity::digest(
        &crate::btcc::identity::stable_json(&value)?,
    ))
}

/// The serialized input as an object; typed inputs are structs.
fn object_mut(value: &mut Value) -> Result<&mut serde_json::Map<String, Value>, BtccError> {
    value.as_object_mut().ok_or_else(|| {
        BtccError::detected(
            BtccCode::DurableWorkSerializationFailed,
            "serialized work input is not an object",
        )
    })
}

fn serialized<T: serde::Serialize>(input: &T) -> Result<Value, BtccError> {
    serde_json::to_value(input).map_err(|error| {
        BtccError::detected(BtccCode::DurableWorkSerializationFailed, error.to_string())
            .with_source(error)
    })
}

fn with_null_project(scope: &WorkTurnScope, map: &mut serde_json::Map<String, Value>) {
    map.insert("turnId".into(), Value::String(scope.turn_id.clone()));
    map.insert("sessionId".into(), Value::String(scope.session_id.clone()));
    map.insert(
        "projectRef".into(),
        scope
            .project_ref
            .as_ref()
            .map_or(Value::Null, |value| Value::String(value.clone())),
    );
}
