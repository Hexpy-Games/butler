//! Child work, completion and dispatch recovery of subsessions.

use super::*;

impl SubsessionService {
    /// Makes sure a child turn is bound to its relation's root Work.
    pub async fn ensure_child_work(&self, session: &str, turn: &str) -> Result<(), BtccError> {
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
        self.ensure_child_work(session, turn).await?;
        if status == "cancelled" {
            self.work
                .abandon_bound_work_for_turn(turn.to_owned())
                .await?;
        }
        let mut evidence_refs = self
            .work
            .bound_work_for_turn(turn.to_owned())
            .await?
            .and_then(|work| work.latest_disposition)
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
                session.into(),
                turn.into(),
                status.into(),
                summary,
                evidence_refs,
                (self.now)(),
            )
            .await
            .map_err(BtccError::from)?;
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
