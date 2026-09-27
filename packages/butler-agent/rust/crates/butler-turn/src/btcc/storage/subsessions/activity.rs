//! Narrow read of the BTCC execution authority used by App relocation admission.

use super::{SqliteSubsessionRepository, StorageError};

impl SqliteSubsessionRepository {
    pub(crate) async fn has_unfinished_execution(
        &self,
        session: String,
    ) -> Result<bool, StorageError> {
        self.storage
            .execute(move |db| {
                let active: bool = db
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM btcc_turns WHERE session_id=?1 AND semantic_state NOT IN ('delivered','cancelled'))",
                        [session],
                        |row| row.get(0),
                    )
                    .map_err(StorageError::sqlite)?;
                Ok(active)
            })
            .await
    }
}
