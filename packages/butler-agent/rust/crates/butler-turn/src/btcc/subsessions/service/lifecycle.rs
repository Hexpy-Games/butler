//! Child work, completion and dispatch recovery of subsessions.

use super::*;

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
        self.repository.storage().work_model_write(move |tx| {
            use butler_work::store::{self, execution};
            use rusqlite::OptionalExtension;
            let existing: bool = tx.query_row("SELECT 1 FROM wm_attempts WHERE task_id=?1 AND session_id=?2 AND turn_id=?3",rusqlite::params![assigned.task_id,session,turn],|_|Ok(())).optional()?.is_some();
            if existing { return Ok(()) }
            let instruction = store::control::next_pending(tx,&session,false)?.into_iter()
                .find(|row| crate::btcc::storage::direction_turn_id(row["id"].as_str().unwrap_or_default())==turn)
                .ok_or(store::Error::Invalid("child turn has no assignment"))?;
            let ctx=admission::context();
            let task=store::read_task(tx,&assigned.task_id)?;
            if let Some(part)=&assigned.part_id {
                if !matches!(task["status"].as_str(),Some("running"|"in_review")) {
                    execution::start_task(tx,&ctx,&assigned.task_id,task["revision"].as_i64().ok_or(store::Error::Invalid("revision"))?,
                        &execution::ExecutionScope{session_id:&assigned.parent_session_id,turn_id:&assigned.parent_turn_id},&format!("parent-attempt:{turn}"))?;
                }
                tx.execute(execution::sql::PART_STATE,rusqlite::params![part,"pending",Option::<&str>::None])?;
                let revision=store::parts::read_part(tx,part)?["revision"].as_i64().ok_or(store::Error::Invalid("revision"))?;
                execution::assign_part(tx,&ctx,part,revision,&assigned.parent_session_id,&execution::ExecutionScope{session_id:&session,turn_id:&turn},&format!("attempt:{turn}"))?;
            } else {
                execution::start_task(tx,&ctx,&assigned.task_id,task["revision"].as_i64().ok_or(store::Error::Invalid("revision"))?,
                    &execution::ExecutionScope{session_id:&session,turn_id:&turn},&format!("attempt:{turn}"))?;
            }
            tx.execute("UPDATE btcc_session_relations SET activity_terminal=0 WHERE relation_id=?1",[&assigned.relation_id])?;
            let _=instruction;
            Ok(())
        }).await.map_err(BtccError::from)?;
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

    async fn deliver_child_result(&self, session: &str, status: &str) -> Result<(), BtccError> {
        self.notify_execution_changed(session).await?;
        // A direction that arrived during this turn and was not applied in it
        // continues the child now that the turn has its result.
        if status != "cancelled"
            && let Err(error) = self.release_pending_direction(session).await
        {
            butler_core::diagnostic!(
                "[native-btcc] pending direction not released code={}",
                error.code()
            );
        }
        self.deliver_worker_results().await
    }
    /// Re-dispatches pending children, directions and worker results after a restart.
    pub async fn recover_dispatches(&self) -> Result<(), BtccError> {
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
                break;
            }
            for intent in intents {
                after = intent["op_id"].as_str().unwrap_or_default().into();
                if intent["kind"] != "child_dispatch" {
                    continue;
                }
                let payload: Value =
                    serde_json::from_str(intent["payload_json"].as_str().unwrap_or_default())
                        .map_err(|e| {
                            error(BtccCode::SubsessionDispatchIntentInvalid).with_source(e)
                        })?;
                let Some(session) = payload
                    .pointer("/delegation/child_session_id")
                    .and_then(Value::as_str)
                else {
                    return Err(error(BtccCode::SubsessionDispatchIntentInvalid));
                };
                if let Some(stored) = self
                    .repository
                    .by_child(session.into())
                    .await
                    .map_err(BtccError::from)?
                {
                    self.ensure_child_binding(&stored).await?;
                    self.replay(&stored).await?;
                }
            }
        }
        self.recover_directions().await?;
        self.deliver_worker_results().await
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
