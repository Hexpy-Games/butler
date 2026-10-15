//! Opt-in owner history for the unchanged N=20 refusal samplers.
use butler_e2e::e2e::{HarnessError, scenario::Scenario};
use rusqlite::Connection;

use crate::{btcc_scale as btcc, transcript_scale as transcripts};

#[path = "active_transcript.rs"]
mod active;

pub(super) struct History(transcripts::Expected, active::Expected);

pub(super) async fn prepare(s: &mut Scenario, chat: &str) -> Result<Option<History>, HarnessError> {
    if std::env::var("BUTLER_E2E_OWNER_SCALE").as_deref() != Ok("1") {
        return Ok(None);
    }
    s.agent.terminate().await?;
    let data = s.sandbox.data.clone();
    let chat = chat.to_owned();
    let history = tokio::task::spawn_blocking(move || {
        let db = Connection::open(data.join("app-server/butler-client.sqlite"))?;
        crate::app_storage_scale::seed::seed_scale(&db, 800, 8_000, 2_000);
        db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
        eprintln!(
            "APPROVAL-SCALE chats=800 turns=8000 events=323000 app_bytes={}",
            std::fs::metadata(data.join("app-server/butler-client.sqlite"))?.len()
        );
        // The agent is stopped. Avoid a second 7+ GB WAL copy while constructing
        // history on bounded tmpfs; runtime measurements still use normal WAL.
        Connection::open(btcc::path(&data))?.execute_batch("PRAGMA journal_mode=DELETE")?;
        btcc::seed(&data)?;
        btcc::assert_complete(&data)?;
        Connection::open(btcc::path(&data))?.execute_batch("PRAGMA journal_mode=WAL")?;
        Ok::<_, HarnessError>(History(
            transcripts::seed(&data)?,
            active::seed(&data, &chat)?,
        ))
    })
    .await
    .map_err(|error| HarnessError(error.to_string()))??;
    s.gw = s.agent.start_again().await?;
    Ok(Some(history))
}

pub(super) async fn assert_complete(
    s: &Scenario,
    history: Option<History>,
) -> Result<(), HarnessError> {
    let Some(history) = history else {
        return Ok(());
    };
    let data = s.sandbox.data.clone();
    tokio::task::spawn_blocking(move || {
        let db = Connection::open(data.join("app-server/butler-client.sqlite"))?;
        for (table, column, prefix, expected) in [
            ("chats", "id", "perf-c%", 800),
            ("turns", "id", "perf-t%", 8_000),
            ("events", "turn_id", "perf-t%", 320_000),
        ] {
            let count: i64 = db.query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE {column} LIKE ?1"),
                [prefix],
                |row| row.get(0),
            )?;
            assert_eq!(count, expected, "complete retained {table}");
        }
        btcc::assert_complete(&data)?;
        btcc::assert_indexed(&data)?;
        progress_shape(&data)?;
        active::assert_complete(&data, &history.1)?;
        transcripts::assert_complete(&data, &history.0)
    })
    .await
    .map_err(|error| HarnessError(error.to_string()))?
}

fn progress_shape(data: &std::path::Path) -> Result<(), HarnessError> {
    let db = Connection::open(btcc::path(data))?;
    let (rows, largest): (i64, i64) = db.query_row(
        "SELECT COUNT(*),COALESCE(MAX(length(CAST(event_json AS BLOB))),0) FROM btcc_progress_events",
        [], |row| Ok((row.get(0)?, row.get(1)?)))?;
    let triggers: i64 = db.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='btcc_progress_events'",
        [], |row| row.get(0))?;
    let plan = db.prepare("EXPLAIN QUERY PLAN UPDATE btcc_progress_events SET status='published' WHERE event_id=?1 AND status='pending'")?
        .query_map(["absent"], |row| row.get::<_, String>(3))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    assert!(plan.iter().all(|step| !step.contains("SCAN")), "{plan:?}");
    eprintln!(
        "APPROVAL-PROGRESS rows={rows} max_payload_bytes={largest} triggers={triggers} plan={plan:?}"
    );
    Ok(())
}
