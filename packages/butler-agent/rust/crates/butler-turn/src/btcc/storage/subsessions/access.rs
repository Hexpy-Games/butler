//! Indexed authoritative parent admission; never trusts a tool's requested tier.
use super::SqliteSubsessionRepository;
use crate::btcc::{BtccError, TurnRecord};

impl SqliteSubsessionRepository {
    pub(crate) async fn parent_turn(&self, id: String) -> Result<Option<TurnRecord>, BtccError> {
        self.storage
            .read(move |db| super::super::hydration::find_turn(db, &id))
            .await
            .map_err(BtccError::from)
    }
}

impl crate::btcc::storage::BtccRepositories {
    pub(crate) async fn child_instruction_run(
        &self,
        session: String,
    ) -> Result<Option<crate::btcc::ScheduleRunContext>, BtccError> {
        let repository = SqliteSubsessionRepository::new(self.storage.clone());
        let initial = repository
            .by_child(session.clone())
            .await
            .map_err(BtccError::from)?
            .and_then(|r| r.packet.schedule_run)
            .filter(|r| !r.automation_id.is_empty());
        if initial.is_some() {
            return Ok(initial);
        }
        repository
            .instruction_run_context(session)
            .await
            .map_err(BtccError::from)
    }
}
