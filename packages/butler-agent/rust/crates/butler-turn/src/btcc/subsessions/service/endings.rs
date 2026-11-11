//! Finish canonical Work closeout before exposing a durable terminal card.
use super::*;

impl SubsessionService {
    pub(super) async fn commit_completion(
        &self,
        completion: crate::btcc::storage::ChildCompletion,
    ) -> Result<(), BtccError> {
        let staged = self
            .repository
            .prepare_ending(completion.clone(), (self.now)())
            .await
            .map_err(BtccError::from)?;
        let completion = if let Some((staged, stopped)) = staged {
            for (session, turn) in stopped {
                self.stop_closed_turn(&session, &turn).await?;
            }
            self.close_canonical_work(&staged.session).await?;
            staged
        } else {
            completion
        };
        let stopped = self
            .repository
            .commit_result(completion, (self.now)())
            .await
            .map_err(BtccError::from)?;
        for (session, turn) in stopped {
            self.stop_closed_turn(&session, &turn).await?;
        }
        Ok(())
    }

    async fn close_canonical_work(&self, session: &str) -> Result<(), BtccError> {
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
            let stopped = self
                .repository
                .commit_result(completion, (self.now)())
                .await
                .map_err(BtccError::from)?;
            for (session, turn) in stopped {
                self.stop_closed_turn(&session, &turn).await?;
            }
        }
        Ok(())
    }

    pub(super) async fn recover_endings(&self) -> Result<(), BtccError> {
        for completion in self
            .repository
            .pending_endings()
            .await
            .map_err(BtccError::from)?
        {
            self.close_canonical_work(&completion.session).await?;
            let session = completion.session.clone();
            let status = completion.status.clone();
            let stopped = self
                .repository
                .commit_result(completion, (self.now)())
                .await
                .map_err(BtccError::from)?;
            for (session, turn) in stopped {
                self.stop_closed_turn(&session, &turn).await?;
            }
            self.deliver_child_result(&session, &status).await?;
        }
        // Older builds saved some results without closing their cards.
        for (session, turn) in self
            .repository
            .close_saved_results((self.now)())
            .await
            .map_err(BtccError::from)?
        {
            self.stop_closed_turn(&session, &turn).await?;
        }
        Ok(())
    }
}
