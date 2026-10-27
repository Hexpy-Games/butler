//! Read a child's inherited origin even when a later instruction started it.
use super::*;
use crate::btcc::ScheduleRunContext;

impl SubsessionService {
    /// Connector origin accumulates; attendance comes from the latest instruction,
    /// falling back to the immutable task packet until the first instruction.
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
                Some(run)
            }
            (run, initial) => run.or(initial),
        })
    }
}
