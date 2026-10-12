//! Indexed conversation provenance; only successful reader output supplies URLs.
use super::ToolJournalRepository;
use crate::btcc::storage::{StorageError, StorageResult};

impl ToolJournalRepository {
    pub async fn remember_read_source(
        &self,
        turn: String,
        call: String,
        session: String,
        source: String,
    ) -> StorageResult<()> {
        self.storage
            .execute(move |db| {
                db.execute(
                    "UPDATE btcc_guided_tool_calls SET read_source_session=?1,read_source=?2 WHERE turn_id=?3 AND call_id=?4",
                    [&session, &source, &turn, &call],
                )
                .map_err(StorageError::sqlite)?;
                Ok(())
            })
            .await
    }

    pub async fn read_sources(
        &self,
        session: String,
        sources: Vec<String>,
    ) -> StorageResult<Vec<String>> {
        self.storage
            .execute(move |db| {
                let mut query = db.prepare_cached(
                "SELECT EXISTS(SELECT 1 FROM btcc_guided_tool_calls WHERE read_source_session=?1 AND read_source=?2 AND status='completed' AND read_source IS NOT NULL)"
            ).map_err(StorageError::sqlite)?;
                let mut found = Vec::new();
                for source in sources {
                    let exists: bool = query
                        .query_row([&session, &source], |row| row.get(0))
                        .map_err(StorageError::sqlite)?;
                    if exists {
                        found.push(source);
                    }
                }
                Ok(found)
            })
            .await
    }
}
