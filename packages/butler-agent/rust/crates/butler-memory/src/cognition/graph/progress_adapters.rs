//! Generation build cursors and the typed source registration adapter.

use rusqlite::OptionalExtension;

use super::{
    CatchupCursors, CognitionResult, GraphRegistration, GraphRepository, TypedRegistrationInput,
    db_error, jobs, typed_registration,
};

impl GraphRepository {
    pub(in crate::cognition) fn catchup_cursors(&self) -> CognitionResult<CatchupCursors> {
        jobs::catchup_cursors(self.connection()?)
    }

    pub(in crate::cognition) fn save_catchup_cursors(
        &mut self,
        cursors: &CatchupCursors,
    ) -> CognitionResult<()> {
        jobs::save_catchup_cursors(self.connection_mut()?, cursors)
    }

    pub(in crate::cognition) fn rebuild_typed_cursor(
        &self,
        snapshot_id: &str,
    ) -> CognitionResult<Option<String>> {
        let stored: Option<String> = self
            .connection()?
            .query_row(
                "SELECT value FROM memory_state WHERE key='rebuild_typed_cursor'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(db_error)?;
        let Some(value) =
            stored.and_then(|value| serde_json::from_str::<serde_json::Value>(&value).ok())
        else {
            return Ok(None);
        };
        if value["snapshot_id"] != snapshot_id {
            return Ok(None);
        }
        Ok(value["source_key"].as_str().map(str::to_owned))
    }

    pub(in crate::cognition) fn register_typed(
        &mut self,
        input: TypedRegistrationInput<'_>,
    ) -> CognitionResult<GraphRegistration> {
        typed_registration::register_typed(self.connection_mut()?, input)
    }
}
