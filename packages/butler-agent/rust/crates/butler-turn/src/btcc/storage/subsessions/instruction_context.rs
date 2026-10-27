//! Latest instruction attendance and sticky connector origin for a child.
use super::*;
use crate::btcc::ScheduleRunContext;

impl SqliteSubsessionRepository {
    pub(crate) async fn instruction_run_context(
        &self,
        session: String,
    ) -> Result<Option<ScheduleRunContext>, StorageError> {
        self.storage.execute(move |db| {
            let raw: Option<String> = db.query_row(
                "SELECT c.instruction_run_context_json FROM btcc_subsession_delegations c JOIN btcc_session_relations r USING(relation_id) WHERE r.child_session_id=?1",
                [session], |r| r.get::<_, Option<String>>(0),
            ).optional().map_err(StorageError::sqlite)?.flatten();
            raw.map(|raw| serde_json::from_str(&raw).map_err(context_error)).transpose()
        }).await
    }

    pub(crate) async fn restrict_instruction_context(
        &self,
        relation: String,
        incoming: Option<ScheduleRunContext>,
    ) -> Result<(), StorageError> {
        self.storage.execute(move |db| {
            let raw: Option<String> = db.query_row(
                "SELECT instruction_run_context_json FROM btcc_subsession_delegations WHERE relation_id=?1",
                [&relation], |r| r.get::<_, Option<String>>(0),
            ).optional().map_err(StorageError::sqlite)?.flatten();
            let previous: Option<ScheduleRunContext> = raw.map(|raw| serde_json::from_str(&raw).map_err(context_error))
                .transpose()?;
            let mut run = incoming.unwrap_or(ScheduleRunContext {
                automation_id: String::new(), run_id: String::new(), unattended: false,
                connector_event: false, scheduled_at: None, browser: None,
            });
            run.connector_event |= previous.is_some_and(|run| run.connector_event);
            let encoded = serde_json::to_string(&run).map_err(context_error)?;
            let changed = db.execute("UPDATE btcc_subsession_delegations SET instruction_run_context_json=?2 WHERE relation_id=?1",
                params![relation, encoded]).map_err(StorageError::sqlite)?;
            if changed != 1 {
                return Err(StorageError::new(StorageCode::SubsessionRelationMissing, "Missing child instruction context"));
            }
            Ok(())
        }).await
    }
}

fn context_error(error: serde_json::Error) -> StorageError {
    StorageError::new(StorageCode::SubsessionPacketInvalid, error.to_string()).with_source(error)
}

/// Latest attendance, preserving connector provenance from the initial instruction.
pub(super) fn current(
    db: &rusqlite::Connection,
    session: &str,
    initial: Option<ScheduleRunContext>,
) -> Result<Option<ScheduleRunContext>, StorageError> {
    let raw: Option<String> = db.query_row(
        "SELECT c.instruction_run_context_json FROM btcc_subsession_delegations c JOIN btcc_session_relations r USING(relation_id) WHERE r.child_session_id=?1",
        [session], |r| r.get::<_, Option<String>>(0),
    ).optional().map_err(StorageError::sqlite)?.flatten();
    let Some(raw) = raw else {
        return Ok(initial);
    };
    let mut run: ScheduleRunContext = serde_json::from_str(&raw).map_err(context_error)?;
    run.connector_event |= initial.is_some_and(|r| r.connector_event);
    Ok(Some(run))
}
