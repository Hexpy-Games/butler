//! Read a child's inherited origin even when a later instruction started it.
use super::*;
use crate::btcc::ScheduleRunContext;

impl SubsessionService {
    /// Restrictions only accumulate for an existing assignment. Its immutable
    /// task packet remains the source of the initial dispatch context.
    pub async fn instruction_run_context(
        &self,
        session: &str,
    ) -> Result<Option<ScheduleRunContext>, BtccError> {
        let stored = self
            .repository
            .instruction_run_context(session.into())
            .await
            .map_err(BtccError::from)?;
        let initial = self
            .repository
            .by_child(session.into())
            .await
            .map_err(BtccError::from)?
            .and_then(|r| r.packet.schedule_run);
        Ok(match (stored, initial) {
            (Some(mut run), Some(initial)) => {
                run.connector_event |= initial.connector_event;
                run.unattended |= initial.unattended;
                if run.automation_id.is_empty() {
                    run.automation_id = initial.automation_id;
                }
                if run.run_id.is_empty() {
                    run.run_id = initial.run_id;
                }
                run.scheduled_at = run.scheduled_at.or(initial.scheduled_at);
                Some(run)
            }
            (run, initial) => run.or(initial),
        })
    }
}
