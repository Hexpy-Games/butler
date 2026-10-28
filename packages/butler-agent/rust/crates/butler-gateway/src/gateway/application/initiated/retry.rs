//! Persist bounded retry deadlines; scheduler sleeps until a known instant.
use super::super::{AppApplication, GatewayApplicationError, app_error};
use crate::gateway::error::FailureClass;
use rusqlite::params;

// 1,2,4,...,256,300 seconds: the tenth failure reaches the cap.
pub(super) const CAPPED_ATTEMPTS: u32 = 10;

impl AppApplication {
    pub(super) async fn initiated_failure(
        &self,
        id: String,
        error: &GatewayApplicationError,
    ) -> Result<(), GatewayApplicationError> {
        let permanent = error.failure_class() == FailureClass::Permanent;
        let reason = match error {
            GatewayApplicationError::Public { code, .. } => code.clone(),
            GatewayApplicationError::Internal { .. } => "internal_error".into(),
        };
        let gate = self.initiated_gate().await?;
        let reason_kind = super::failures::Reason::from_error(error);
        let now = gate.now;
        let subscribers = self.subscribers.clone();
        self.storage.execute(move |db| {
            let tx = db.savepoint().map_err(super::super::AppStorageError::sqlite)?;
            let attempts: u32 = tx.query_row("SELECT attempts FROM app_initiated_messages WHERE id=?1", [&id], |r| r.get(0))
                .map_err(super::super::AppStorageError::sqlite)?;
            let time = chrono::DateTime::parse_from_rfc3339(&now).map_err(|_| super::super::automations::timing::invalid())?;
            let next = (time + chrono::Duration::seconds((1_i64 << attempts.min(9)).min(300)))
                .with_timezone(&chrono::Utc).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            let changed = tx.execute("UPDATE app_initiated_messages SET state=?1,posting=0,reason=?2,attempts=attempts+1,next_attempt_at=?3 WHERE id=?4 AND state='held'",
                params![if permanent {"failed"} else {"held"},reason,if permanent || reason == "session_model_unavailable" {None} else {Some(next)},&id])
                .map_err(super::super::AppStorageError::sqlite)?;
            if permanent && changed == 1 {
                let work: bool = tx.query_row("SELECT kind='work_result' FROM app_initiated_messages WHERE id=?1", [&id], |r| r.get(0)).map_err(super::super::AppStorageError::sqlite)?;
                if work && let Some(event) = super::failures::enqueue(&tx, &id, &reason_kind, &gate.language, false, &now)? {
                    super::super::events::publish(&subscribers, &event);
                }
            }
            tx.commit().map_err(super::super::AppStorageError::sqlite)
        }).await.map_err(app_error)?;
        if permanent {
            self.projection.handoffs_changed();
        }
        self.automation_wake.notify_one();
        self.queue_wake.wake(None).await?;
        Ok(())
    }
    pub(super) async fn work_retry_pending(
        &self,
        id: String,
    ) -> Result<bool, GatewayApplicationError> {
        let now = self.dependencies.identity_clock.now_iso();
        self.storage.read(move |db| db.query_row("SELECT reason='session_model_unavailable' OR (next_attempt_at IS NOT NULL AND next_attempt_at>?1) FROM app_initiated_messages WHERE id=?2", params![now,id], |r| Ok(r.get::<_,Option<bool>>(0)?.unwrap_or(false)))
            .map_err(super::super::AppStorageError::sqlite)).await.map_err(app_error)
    }

    pub(in crate::gateway::application) async fn retry_model_results(
        &self,
        chat: String,
    ) -> Result<(), GatewayApplicationError> {
        let changed = self.storage.execute(move |db| db.execute("UPDATE app_initiated_messages SET reason=NULL WHERE chat_id=?1 AND state='held' AND kind='work_result' AND reason='session_model_unavailable'", [chat]).map_err(super::super::AppStorageError::sqlite)).await.map_err(app_error)?;
        if changed > 0 {
            self.automation_wake.notify_one();
        }
        Ok(())
    }

    /// Shipped builds inject no delivery faults.
    #[cfg(not(feature = "e2e-fixtures"))]
    pub(super) fn work_send_fault(
        &self,
        _: &str,
    ) -> std::future::Ready<Result<(), GatewayApplicationError>> {
        std::future::ready(Ok(()))
    }

    #[cfg(feature = "e2e-fixtures")]
    pub(super) async fn work_send_fault(&self, id: &str) -> Result<(), GatewayApplicationError> {
        let failures = std::env::var("BUTLER_E2E_WORK_SEND_FAILURES")
            .ok()
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(0);
        if failures == 0 {
            return Ok(());
        }
        let key = id.to_owned();
        let attempts: u32 = self
            .storage
            .read(move |db| {
                db.query_row(
                    "SELECT attempts FROM app_initiated_messages WHERE id=?1",
                    [key],
                    |r| r.get(0),
                )
                .map_err(super::super::AppStorageError::sqlite)
            })
            .await
            .map_err(app_error)?;
        if attempts < failures {
            return Err(GatewayApplicationError::public(
                503,
                "work_send_unavailable",
                "Delivery unavailable.",
            ));
        }
        Ok(())
    }
}
