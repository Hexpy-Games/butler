//! Child work, completion and dispatch recovery of subsessions.

use super::*;

impl SubsessionService {
    /// Makes sure a child turn is bound to its relation's root Work.
    pub async fn ensure_child_work(&self, session: &str, turn: &str) -> Result<(), BtccError> {
        self.bind_child_work(session, turn).await?;
        if self
            .repository
            .by_child(session.into())
            .await
            .map_err(BtccError::from)?
            .is_some_and(|r| r.packet.child_role == ChildRole::Steward)
            && let Err(error) = self.admit_waiting(session).await
        {
            butler_core::diagnostic!(
                "[native-btcc] Worker turn-start admission deferred code={}",
                error.code()
            );
        }
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
            if (existing.work_id != stored.root_work_id
                && !(stored.packet.child_role == ChildRole::Worker && turn != stored.child_turn_id))
                || existing.session_id != session
                || !work_matches_scope(&existing, &scope)
            {
                return Err(error(BtccCode::SubsessionRootWorkIdentityMismatch));
            }
            return Ok(());
        }
        if turn != stored.child_turn_id && stored.packet.child_role == ChildRole::Worker {
            return self.bind_worker_continuation(&stored, scope).await;
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
        let disposition = self
            .result_disposition(session, turn, status, failure_code.as_deref())
            .await?;
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

    async fn result_disposition(
        &self,
        session: &str,
        turn: &str,
        status: &str,
        failure_code: Option<&str>,
    ) -> Result<Option<crate::btcc::WorkDisposition>, BtccError> {
        // A queued cancellation can precede turn admission. It saves a result
        // without creating either a Turn or execution authority for a stop.
        if status == "cancelled"
            && !self
                .repository
                .child_turn_exists(session.into(), turn.into())
                .await
                .map_err(BtccError::from)?
        {
            return Ok(None);
        }
        if status != "cancelled" || self.work.bound_work_for_turn(turn.into()).await?.is_some() {
            self.bind_result_work(session, turn, failure_code).await?;
        }
        if status == "cancelled" {
            self.work.abandon_bound_work_for_turn(turn.into()).await?;
        }
        Ok(self
            .work
            .bound_work_for_turn(turn.into())
            .await?
            .and_then(|work| work.latest_disposition))
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
        let relation = self
            .repository
            .by_child(session.into())
            .await
            .map_err(BtccError::from)?;
        if relation
            .as_ref()
            .is_some_and(|r| r.packet.child_role == ChildRole::Steward)
            && status != "cancelled"
            && let Err(error) = self.release_pending_direction(session).await
        {
            butler_core::diagnostic!(
                "[native-btcc] pending direction not released code={}",
                error.code()
            );
        }
        let delivery = self.deliver_worker_results().await;
        if let Some(relation) = relation
            && relation.packet.child_role == ChildRole::Worker
            && let Err(error) = self.admit_waiting(&relation.parent_session_id).await
        {
            butler_core::diagnostic!(
                "[native-btcc] Worker admission deferred code={}",
                error.code()
            );
        }
        delivery
    }

    /// Main's recovery order: dispatches, directions, then parent results.
    /// Worker admission follows result delivery; one failure never hides peers.
    pub async fn recover_dispatches(&self) -> Result<(), BtccError> {
        let mut failed_parents = std::collections::HashSet::new();
        for stored in self
            .repository
            .pending_dispatches()
            .await
            .map_err(BtccError::from)?
        {
            if stored.packet.child_role == ChildRole::Worker {
                if let Err(error) = self.prepare_child_binding(&stored).await
                    && !Self::worker_publish_error_is_permanent(&error)
                {
                    failed_parents.insert(stored.parent_session_id);
                    butler_core::diagnostic!(
                        "[native-btcc] Worker recovery binding deferred code={}",
                        error.code()
                    );
                }
            } else {
                self.ensure_child_binding(&stored).await?;
                self.replay(&stored).await?;
            }
        }
        self.recover_directions().await?;
        if let Err(error) = self.deliver_worker_results().await {
            butler_core::diagnostic!(
                "[native-btcc] Worker recovery delivery deferred code={}",
                error.code()
            );
        }
        for stored in self
            .repository
            .enqueued_workers()
            .await
            .map_err(BtccError::from)?
        {
            if self.publish_worker(&stored).await.is_err() {
                failed_parents.insert(stored.parent_session_id);
            }
        }
        self.admit_waiting_except(failed_parents).await
    }
    /// Whether the parent session has an active child to wait for.
    pub async fn should_wait_for_child(&self, parent: &str) -> Result<bool, BtccError> {
        self.repository
            .has_active_child(parent.to_owned())
            .await
            .map_err(BtccError::from)
    }
    /// Non-terminal turn ids, revisions and automatic authority resume flags.
    pub async fn unfinished_execution_turns(
        &self,
        session_id: &str,
    ) -> Result<Vec<(String, u64, bool)>, BtccError> {
        self.repository
            .unfinished_execution_turns(session_id.to_owned())
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
