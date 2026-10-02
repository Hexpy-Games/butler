//! Generation build cursors and the typed source registration adapter.

use crate::lenient::JsonField;
use rusqlite::OptionalExtension;

use super::{
    CatchupState, CognitionResult, GraphRegistration, GraphRepository, TypedRegistrationInput,
    db_error, jobs, typed_registration,
};

impl GraphRepository {
    pub(in crate::cognition) fn catchup_state(&self) -> CognitionResult<CatchupState> {
        jobs::catchup_state(self.connection()?)
    }

    pub(in crate::cognition) fn save_catchup_state(
        &mut self,
        state: &CatchupState,
    ) -> CognitionResult<()> {
        jobs::save_catchup_state(self.connection_mut()?, state)
    }

    pub(in crate::cognition) fn has_recoverable_windows(&self) -> CognitionResult<bool> {
        super::probe::has_recoverable_windows(self.connection()?)
    }

    pub(in crate::cognition) fn vector_batch_due(
        &self,
        cutoff: &str,
        cap: usize,
    ) -> CognitionResult<bool> {
        super::probe::vector_batch_due(self.connection()?, cutoff, cap)
    }

    pub(in crate::cognition) fn has_vector_work(&self, now: &str) -> CognitionResult<bool> {
        super::probe::has_vector_work(self.connection()?, now)
    }

    pub(in crate::cognition) fn registered_observations(
        &self,
        ids: &[String],
    ) -> CognitionResult<std::collections::HashSet<String>> {
        jobs::registered_observations(self.connection()?, ids)
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
        if value.field("snapshot_id") != snapshot_id {
            return Ok(None);
        }
        Ok(value.field("source_key").as_str().map(str::to_owned))
    }

    pub(in crate::cognition) fn register_typed(
        &mut self,
        input: TypedRegistrationInput<'_>,
    ) -> CognitionResult<GraphRegistration> {
        typed_registration::register_typed(self.connection_mut()?, input)
    }
}
