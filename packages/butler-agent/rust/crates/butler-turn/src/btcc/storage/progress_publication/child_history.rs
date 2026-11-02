//! Indexed session-order pages; private events advance the cursor but never leave storage.
use super::*;

impl StorageProgressPublication {
    /// Public progress across every child turn, plus the next source cursor and more flag.
    pub async fn read_child_activity_page(
        &self,
        session: String,
        after: u64,
        limit: usize,
    ) -> StorageResult<(Vec<Value>, u64, bool)> {
        let limit = limit.clamp(1, 200);
        self.storage.read(move |db| {
            let mut statement = db.prepare_cached(
                "SELECT p.event_id,p.session_sequence,p.turn_sequence,p.turn_id,p.event_json,p.created_at \
                 FROM btcc_progress_events p WHERE p.session_id=?1 AND p.session_sequence>?2 \
                 AND EXISTS(SELECT 1 FROM btcc_session_relations r WHERE r.child_session_id=p.session_id) \
                 ORDER BY p.session_sequence LIMIT ?3",
            ).map_err(StorageError::sqlite)?;
            let mut rows = statement.query(params![session, after, limit + 1])
                .map_err(StorageError::sqlite)?;
            let mut events = Vec::new();
            let mut cursor = after;
            let mut count = 0;
            while let Some(row) = rows.next().map_err(StorageError::sqlite)? {
                if count == limit { return Ok((events, cursor, true)); }
                count += 1;
                cursor = row.get(1).map_err(StorageError::sqlite)?;
                let raw: String = row.get(4).map_err(StorageError::sqlite)?;
                let Ok(mut event) = serde_json::from_str::<Value>(&raw) else { continue; };
                if event.get("visibility").and_then(Value::as_str) != Some("public") { continue; }
                let Some(object) = event.as_object_mut() else { continue; };
                object.insert("id".into(), row.get::<_, String>(0).map_err(StorageError::sqlite)?.into());
                object.insert("turnSequence".into(), row.get::<_, u64>(2).map_err(StorageError::sqlite)?.into());
                object.insert("turnId".into(), row.get::<_, String>(3).map_err(StorageError::sqlite)?.into());
                object.insert("createdAt".into(), row.get::<_, String>(5).map_err(StorageError::sqlite)?.into());
                events.push(event);
            }
            Ok((events, cursor, false))
        }).await
    }
}
