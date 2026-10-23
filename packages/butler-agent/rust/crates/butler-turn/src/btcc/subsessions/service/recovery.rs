//! Startup replay is driven by durable intents, attempts and read-only imports.
use super::*;
use crate::btcc::Child;
use butler_core::json::at;

impl SubsessionService {
    pub async fn recover_assignments(&self, interrupted: Vec<Value>) -> Result<(), BtccError> {
        self.recover_native_assignments(interrupted).await?;
        for child in self
            .repository
            .recover_legacy_assignments()
            .await
            .map_err(BtccError::from)?
        {
            self.ensure_child_binding(&child).await?;
            self.dispatch_or_wait(&child).await?;
        }
        self.repository
            .recover_legacy_results()
            .await
            .map_err(BtccError::from)?;
        self.recover_directions().await?;
        self.deliver_worker_results().await
    }

    pub async fn recover_native_assignments(
        &self,
        interrupted: Vec<Value>,
    ) -> Result<(), BtccError> {
        self.replay_pending_assignments(false).await?;
        for attempt in interrupted {
            let Some(session) = at(&attempt, "/session_id").as_str() else {
                continue;
            };
            if self
                .repository
                .by_child(session.into())
                .await
                .map_err(BtccError::from)?
                .is_some()
            {
                let turn = at(&attempt, "/turn_id")
                    .as_str()
                    .ok_or_else(|| error(BtccCode::SubsessionDispatchIntentInvalid))?;
                self.complete_failed_child(session, turn, "child_turn_interrupted")
                    .await?;
            }
        }
        self.recover_directions().await?;
        self.deliver_worker_results().await
    }

    /// Release only waiting workers once their configured cap is available.
    pub async fn recover_waiting_workers(&self) -> Result<(), BtccError> {
        self.replay_pending_assignments(true).await
    }

    async fn replay_pending_assignments(&self, workers: bool) -> Result<(), BtccError> {
        let mut after = String::new();
        loop {
            let cursor = after.clone();
            let intents = self
                .repository
                .storage()
                .work_model_read(move |db| butler_work::store::pending_intents(db, &cursor, 100))
                .await
                .map_err(BtccError::from)?;
            if intents.is_empty() {
                return Ok(());
            }
            for intent in intents {
                after = at(&intent, "/op_id").as_str().unwrap_or_default().into();
                if at(&intent, "/kind") != "child_dispatch" {
                    continue;
                }
                let payload: Value =
                    serde_json::from_str(at(&intent, "/payload_json").as_str().unwrap_or_default())
                        .map_err(|e| {
                            error(BtccCode::SubsessionDispatchIntentInvalid).with_source(e)
                        })?;
                let Some(session) = payload
                    .pointer("/delegation/child_session_id")
                    .and_then(Value::as_str)
                else {
                    return Err(error(BtccCode::SubsessionDispatchIntentInvalid));
                };
                if let Some(Child::Assigned(stored)) = self
                    .repository
                    .by_child(session.into())
                    .await
                    .map_err(BtccError::from)?
                {
                    if (stored.delegation.packet.child_role == ChildRole::Worker) != workers {
                        continue;
                    }
                    if workers {
                        self.profiles.wait_ready().await?;
                    }
                    let child = Child::Assigned(stored);
                    self.ensure_child_binding(&child).await?;
                    self.dispatch_or_wait(&child).await?;
                }
            }
        }
    }
}
