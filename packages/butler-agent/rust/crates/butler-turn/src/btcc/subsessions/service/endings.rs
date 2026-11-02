//! Finish canonical Work closeout before exposing a durable terminal card.
use super::*;

impl SubsessionService {
    pub(super) async fn commit_completion(
        &self,
        completion: crate::btcc::storage::ChildCompletion,
    ) -> Result<(), BtccError> {
        let staged = self
            .repository
            .prepare_ending(completion.clone(), (self.now)(), false)
            .await
            .map_err(BtccError::from)?;
        let completion = if let Some(staged) = staged {
            self.close_canonical_work(&staged.session).await?;
            staged
        } else {
            completion
        };
        self.repository
            .commit_result(completion, (self.now)())
            .await
            .map_err(BtccError::from)?;
        self.deliver_terminal_controls().await
    }

    async fn close_canonical_work(&self, session: &str) -> Result<(), BtccError> {
        self.deliver_terminal_controls().await?;
        #[cfg(feature = "e2e-fixtures")]
        super::handoff_hold::ending(b"fenced").await?;
        for turn in self
            .repository
            .ending_work_turns(session.into())
            .await
            .map_err(BtccError::from)?
        {
            self.work.abandon_bound_work_for_turn(turn).await?;
        }
        Ok(())
    }

    pub(super) async fn finish_pending_ending(&self, session: &str) -> Result<(), BtccError> {
        if let Some(completion) = self
            .repository
            .pending_ending(session.into())
            .await
            .map_err(BtccError::from)?
        {
            self.close_canonical_work(session).await?;
            self.repository
                .commit_result(completion, (self.now)())
                .await
                .map_err(BtccError::from)?;
        }
        self.deliver_terminal_controls().await
    }

    pub(super) async fn recover_endings(&self) -> Result<(), BtccError> {
        self.repository
            .retire_late_directions((self.now)())
            .await
            .map_err(BtccError::from)?;
        for completion in self
            .repository
            .terminal_recovery_completions()
            .await
            .map_err(BtccError::from)?
        {
            self.repository
                .prepare_ending(completion, (self.now)(), true)
                .await
                .map_err(BtccError::from)?;
        }
        for completion in self
            .repository
            .pending_endings()
            .await
            .map_err(BtccError::from)?
        {
            self.close_canonical_work(&completion.session).await?;
            let session = completion.session.clone();
            let status = completion.status.clone();
            self.repository
                .commit_result(completion, (self.now)())
                .await
                .map_err(BtccError::from)?;
            self.deliver_child_result(&session, &status).await?;
        }
        self.deliver_terminal_controls().await
    }

    pub(super) async fn deliver_terminal_controls(&self) -> Result<(), BtccError> {
        for (session, turn) in self
            .repository
            .pending_terminal_controls()
            .await
            .map_err(BtccError::from)?
        {
            self.stop_closed_turn(&session, &turn)?;
            self.repository
                .terminal_control_dispatched(turn)
                .await
                .map_err(BtccError::from)?;
        }
        Ok(())
    }
}
