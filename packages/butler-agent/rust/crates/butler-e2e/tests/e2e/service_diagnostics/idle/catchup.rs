//! Complete canonical reconciliation is separate from the sync queue receipt.
use butler_platform::sqlite;
use rusqlite::{OpenFlags, OptionalExtension};
use std::path::Path;

pub(super) fn settled(data: &Path, turn: &str) -> bool {
    let Ok(source) = sqlite::open_with_flags(
        data.join("runtime/conversation-store.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    ) else {
        return false;
    };
    let Some((outcome, revision, identity)) = source
        .query_row(
            "SELECT o.id,CAST(s.revision AS TEXT),i.identity FROM conversation_turn_outcomes o,
         conversation_public_source_state s,conversation_source_identity i
         WHERE o.turn_id=?1 AND s.singleton=1 AND i.singleton=1",
            [turn],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .unwrap()
    else {
        return false;
    };
    drop(source);
    let Some(path) = super::graph(data) else {
        return false;
    };
    let Ok(db) = sqlite::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return false;
    };
    let reconciled: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM memory_projection_jobs j JOIN memory_chunks c
         ON c.memory_chunk_id=j.episode_id, json_each(j.observed_completion_job_ids) observed
         WHERE c.source_key=?1 AND observed.value=?2)
         AND EXISTS(SELECT 1 FROM memory_state WHERE key='canonical_catchup_outcome_cursor' AND value=?3)
         AND EXISTS(SELECT 1 FROM memory_state WHERE key='canonical_catchup_sweep_revision' AND value=?4)
         AND EXISTS(SELECT 1 FROM memory_state WHERE key='canonical_catchup_source_identity' AND value=?5)
         AND EXISTS(SELECT 1 FROM memory_state WHERE key='canonical_catchup_sweep_done' AND value='1')",
        rusqlite::params![format!("conversation_turn:{turn}"), format!("catchup:outcome:{outcome}"), outcome, revision, identity],
        |row| row.get(0),
    ).unwrap();
    reconciled
}
