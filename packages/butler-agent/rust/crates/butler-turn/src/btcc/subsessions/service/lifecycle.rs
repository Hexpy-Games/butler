//! Child work, completion and dispatch recovery of subsessions.

use super::*;

impl SubsessionService {
    /// Makes sure a child turn is bound to its relation's root Work.
    pub async fn ensure_child_work(&self, session: &str, turn: &str) -> Result<(), BtccError> {
        self.bind_child_work(session, turn).await?;
        self.notify_execution_changed(session).await
    }

    async fn bind_child_work(&self, session: &str, turn: &str) -> Result<(), BtccError> {
        let stored = self
            .repository
            .by_child(session.into())
            .await
            .map_err(BtccError::from)?
            .ok_or_else(|| error(BtccCode::SubsessionRelationMissing))?;
        let binding = self
            .bindings
            .get_by_session_id(session)
            .await
            .map_err(BtccError::from)?
            .ok_or_else(|| error(BtccCode::SubsessionChildBindingMissing))?;
        let scope = child_work_scope(&stored, &binding, turn)?;
        let existing = self.work.bound_work_for_turn(turn.into()).await?;
        if let Some(existing) = existing {
            if existing.work_id != stored.root_work_id
                || existing.session_id != session
                || !work_matches_scope(&existing, &scope)
            {
                return Err(error(BtccCode::SubsessionRootWorkIdentityMismatch));
            }
            return Ok(());
        }
        if turn != stored.child_turn_id {
            let bound = self
                .work
                .bind_open_work(scope.clone(), Some(stored.root_work_id.clone()))
                .await?
                .ok_or_else(|| error(BtccCode::SubsessionRootWorkIdentityMismatch))?;
            if bound.work_id != stored.root_work_id
                || bound.session_id != session
                || !work_matches_scope(&bound, &scope)
            {
                return Err(error(BtccCode::SubsessionRootWorkIdentityMismatch));
            }
            return Ok(());
        }
        let mutation = format!(
            "subsession-root-work:{}:{}:{}",
            stored.delegation_id, stored.task_id, stored.child_session_id
        );
        let work = self
            .work
            .start_work(StartWorkInput {
                scope,
                mutation_call_id: mutation,
                objective: stored.packet.objective.clone(),
                backfill_tool_call_ids: None,
            })
            .await?;
        if work.work_id != stored.root_work_id
            || work.session_id != session
            || !work_matches_scope(&work, &child_work_scope(&stored, &binding, turn)?)
        {
            return Err(error(BtccCode::SubsessionRootWorkIdentityMismatch));
        }
        Ok(())
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
        // Cancellation can precede the child's first execution. Validate an
        // existing binding, but never create execution authority for a stop.
        if status != "cancelled" || self.work.bound_work_for_turn(turn.into()).await?.is_some() {
            self.bind_result_work(session, turn, failure_code.as_deref())
                .await?;
        }
        if status == "cancelled" {
            self.work
                .abandon_bound_work_for_turn(turn.to_owned())
                .await?;
        }
        let disposition = self
            .work
            .bound_work_for_turn(turn.to_owned())
            .await?
            .and_then(|work| work.latest_disposition);
        let blocked = disposition
            .as_ref()
            .filter(|value| value.disposition == crate::btcc::DispositionStatus::Blocked);
        let failure_reason = failure_code.clone().or_else(|| {
            blocked
                .map(|value| {
                    value
                        .next_condition
                        .clone()
                        .unwrap_or_else(|| value.summary.clone())
                })
                .or_else(|| (status == "failed").then(|| summary.clone()))
        });
        let status = if status == "success" && blocked.is_some() {
            "blocked"
        } else {
            status
        };
        let handoff = disposition
            .as_ref()
            .filter(|value| value.disposition == crate::btcc::DispositionStatus::Blocked)
            .and_then(|value| value.next_condition.as_deref())
            .and_then(crate::btcc::CapabilityHandoff::from_condition);
        let mut evidence_refs = disposition
            .map(|disposition| disposition.evidence_snapshot)
            .unwrap_or_default();
        evidence_refs.extend(
            self.repository
                .child_result_evidence(session.to_owned())
                .await
                .map_err(BtccError::from)?,
        );
        evidence_refs.sort();
        evidence_refs.dedup();
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
                    handoff,
                },
                (self.now)(),
            )
            .await
            .map_err(BtccError::from)?;
        self.deliver_child_result(session, status).await
    }

    async fn bind_result_work(
        &self,
        session: &str,
        turn: &str,
        failure_code: Option<&str>,
    ) -> Result<(), BtccError> {
        if let Err(error) = self.bind_child_work(session, turn).await {
            // A runtime failure answers the parent even when the child's Work
            // cannot be bound; the failure needs no Work disposition.
            if failure_code.is_none() {
                return Err(error);
            }
            butler_core::diagnostic!(
                "[native-btcc] failed child Work unbound code={}",
                error.code()
            );
        }
        Ok(())
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
        for stored in self
            .repository
            .pending_dispatches()
            .await
            .map_err(BtccError::from)?
        {
            self.ensure_child_binding(&stored).await?;
            self.replay(&stored).await?;
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
