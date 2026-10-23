//! Child work, completion and dispatch recovery of subsessions.

mod continuation;

use super::*;
use rusqlite::OptionalExtension;

impl SubsessionService {
    /// Verifies an initial assignment, or claims a continuation's new attempt.
    pub async fn ensure_child_assignment(
        &self,
        session: &str,
        turn: &str,
    ) -> Result<(), BtccError> {
        let child = self
            .repository
            .by_child(session.into())
            .await
            .map_err(BtccError::from)?
            .ok_or_else(|| error(BtccCode::SubsessionRelationMissing))?;
        let crate::btcc::subsessions::assignment::Child::Assigned(assigned) = child else {
            return Err(error(BtccCode::SubsessionRootWorkIdentityMismatch));
        };
        let session = session.to_owned();
        let turn = turn.to_owned();
        let notifying_session = session.clone();
        self.repository
            .storage()
            .work_model_write(move |tx| {
                use rusqlite::OptionalExtension;
                let existing: bool = tx
                    .query_row(
                        crate::btcc::storage::native_sql::SUBSESSIONS_SERVICE_LIFECYCLE_1,
                        rusqlite::params![assigned.task_id, session, turn],
                        |_| Ok(()),
                    )
                    .optional()?
                    .is_some();
                if existing {
                    return Ok(());
                }
                continuation::claim(tx, &assigned, &session, &turn)?;
                tx.execute(
                    crate::btcc::storage::native_sql::SUBSESSIONS_SERVICE_LIFECYCLE_2,
                    [&assigned.relation_id],
                )?;
                Ok(())
            })
            .await
            .map_err(BtccError::from)?;
        self.notify_execution_changed(&notifying_session).await
    }
    /// Compatibility for callers transitioning to the native assignment port.
    pub async fn ensure_child_work(&self, session: &str, turn: &str) -> Result<(), BtccError> {
        self.ensure_child_assignment(session, turn).await
    }
    /// Commits a child's result with its evidence and delivers worker results.
    pub async fn complete_child(
        &self,
        session: &str,
        turn: &str,
        status: &str,
        summary: String,
    ) -> Result<(), BtccError> {
        self.complete_child_result(session, turn, status, summary, None)
            .await
    }

    /// A terminal runtime failure returns only its stable code to the parent.
    pub async fn complete_failed_child(
        &self,
        session: &str,
        turn: &str,
        code: &str,
    ) -> Result<(), BtccError> {
        self.complete_child_result(
            session,
            turn,
            "failed",
            format!("Delegated work could not continue: {code}."),
            Some(code.into()),
        )
        .await
    }

    /// Whether the child turn's result is saved.
    pub async fn child_turn_closed(&self, session: &str, turn: &str) -> Result<bool, BtccError> {
        self.repository
            .has_turn_result(session.to_owned(), turn.to_owned())
            .await
            .map_err(BtccError::from)
    }

    async fn complete_child_result(
        &self,
        session: &str,
        turn: &str,
        status: &str,
        summary: String,
        failure_code: Option<String>,
    ) -> Result<(), BtccError> {
        let evidence_refs = self
            .repository
            .child_result_evidence(session.to_owned())
            .await
            .map_err(BtccError::from)?;
        let failure_reason = failure_code
            .clone()
            .or_else(|| (status == "failed").then(|| summary.clone()));
        self.repository
            .commit_result(
                crate::btcc::storage::ChildCompletion {
                    session: session.into(),
                    turn: turn.into(),
                    status: status.into(),
                    summary,
                    failure_reason,
                    failure_code,
                    evidence_refs,
                    handoff: None,
                },
                (self.now)(),
            )
            .await
            .map_err(BtccError::from)?;
        self.deliver_child_result(session, status).await
    }

    async fn deliver_child_result(&self, session: &str, _status: &str) -> Result<(), BtccError> {
        self.notify_execution_changed(session).await?;
        // A direction that arrived during this turn and was not applied in it
        // continues the child now that the turn has its result.
        if let Err(error) = self.release_pending_direction(session).await {
            butler_core::diagnostic!(
                "[native-btcc] pending direction not released code={}",
                error.code()
            );
        }
        self.deliver_worker_results().await
    }
    /// W-C applies to every result-carrying turn, including the Steward queue.
    pub async fn report_parent_turn(&self, session: &str, message: &str) -> Result<(), BtccError> {
        let result = message
            .strip_prefix("subsession-result-message:")
            .or_else(|| message.strip_prefix("worker-result-message:"))
            .or_else(|| message.starts_with("result-").then_some(message));
        let Some(attempt) = result.and_then(|result| result.strip_prefix("result-")) else {
            return Ok(());
        };
        let attempt = attempt.to_owned();
        let session = session.to_owned();
        let child = self
            .repository
            .storage()
            .work_model_write(move |tx| {
                butler_work::store::end_delegated_delivery(
                    tx,
                    &admission::context(),
                    &attempt,
                    &session,
                )?;
                Ok(tx
                    .query_row(
                        crate::btcc::storage::native_sql::SUBSESSIONS_SERVICE_REPORT_CHILD,
                        [&attempt],
                        |r| r.get::<_, String>(0),
                    )
                    .optional()?)
            })
            .await
            .map_err(BtccError::from)?;
        if let Some(child) = child {
            self.notify_execution_changed(&child).await?;
        }
        Ok(())
    }
    /// Whether the parent session has an active child to wait for.
    pub async fn should_wait_for_child(&self, parent: &str) -> Result<bool, BtccError> {
        self.repository
            .has_active_child(parent.to_owned())
            .await
            .map_err(BtccError::from)
    }
    /// Whether the session has unfinished subsession execution.
    pub async fn has_unfinished_execution(&self, session_id: &str) -> Result<bool, BtccError> {
        self.repository
            .has_unfinished_execution(session_id.to_owned())
            .await
            .map_err(BtccError::from)
    }
    /// The subsession store.
    pub fn repository(&self) -> SqliteSubsessionRepository {
        self.repository.clone()
    }
    /// The configured worker profiles that are enabled.
    pub async fn enabled_worker_profiles(&self) -> Result<Vec<WorkerProfile>, BtccError> {
        Ok(self
            .profiles
            .list()
            .await?
            .into_iter()
            .filter(|profile| profile.enabled)
            .collect())
    }
}
