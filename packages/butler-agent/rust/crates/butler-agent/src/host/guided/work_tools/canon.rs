use super::*;
use butler_canon::store;
use butler_turn::btcc::ReplacePlanInput;

impl GuidedWorkTools {
    pub(super) async fn replace_canon_plan(
        &self,
        input: ReplacePlanInput,
    ) -> Result<WorkView, BtccError> {
        let storage = &self.canon;
        let work = if input.start_new.unwrap_or(false) {
            self.service
                .bound_work_for_turn(self.scope.turn_id.clone())
                .await?
                .map(|w| w.work_id)
        } else {
            self.service
                .load_context(self.scope.clone())
                .await?
                .map(|c| c.work.work_id)
        };
        let session = self.scope.session_id.clone();
        let refs = input.governing_refs.clone().unwrap_or_default();
        let rejection = storage
            .canon_read(move |db| store::precheck_epic_link(db, &session, work.as_deref(), &refs))
            .await?;
        if let Some(rejection) = rejection {
            return Err(BtccError::relayed(
                rejection["code"].as_str().unwrap_or_default().to_owned(),
                rejection["message"].as_str().unwrap_or_default().to_owned(),
            ));
        }
        let refs = input.governing_refs.clone().unwrap_or_default();
        let work = self.service.replace_plan(input).await?;
        let id = work.work_id.clone();
        let session = self.scope.session_id.clone();
        if let Err(error) = storage
            .canon_write(move |tx| {
                store::link_work(
                    tx,
                    &store::runtime_context(chrono::Utc::now().timestamp_millis()),
                    &session,
                    &id,
                    &refs,
                )
            })
            .await
        {
            tracing::warn!(%error, work_id = %work.work_id, "Canon link deferred to reconciliation after committed plan");
        }
        Ok(work)
    }
}
