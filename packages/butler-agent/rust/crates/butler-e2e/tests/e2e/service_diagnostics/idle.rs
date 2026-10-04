//! Measure idle only after startup and the delivered turn's memory work settle.
use butler_e2e::e2e::{HarnessError, scenario::Scenario, stop_intent::instance_record};
use butler_platform::process_control::usage;
use butler_platform::sqlite;
use rusqlite::OpenFlags;
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};
#[path = "idle/catchup.rs"]
mod catchup;

fn graph(data: &Path) -> Option<PathBuf> {
    let root = data.join("cognition/memory");
    let descriptor: Value =
        serde_json::from_slice(&fs::read(root.join("active-generation.json")).ok()?).ok()?;
    Some(
        root.join("generations")
            .join(descriptor["generation_id"].as_str()?)
            .join("graph.sqlite"),
    )
}

pub(super) async fn memory_initialized(data: &Path) -> Result<(), HarnessError> {
    until(|| graph(data).is_some_and(|path| path.is_file())).await
}

async fn until(mut ready: impl FnMut() -> bool) -> Result<(), HarnessError> {
    tokio::time::timeout(Duration::from_secs(30), async {
        while !ready() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .map_err(|_| HarnessError("memory work did not settle before idle measurement".into()))
}

fn settled(data: &Path, turn: &str) -> bool {
    let Some(graph) = graph(data) else {
        return false;
    };
    let Ok(db) = sqlite::open_with_flags(graph, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return false;
    };
    let complete: i64 = db.query_row("SELECT COUNT(*) FROM memory_projection_jobs j JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id WHERE c.source_key=?1 AND json_extract(j.semantic_graph_state,'$.state')='complete' AND json_extract(j.hot_cache_state,'$.state')='complete'", [format!("conversation_turn:{turn}")], |row| row.get(0)).unwrap();
    // Ordinary cold turns preserve vectors for a later admitted batch. This
    // fixture has exactly the user's and assistant's episode units, neither
    // attempted nor failed, and no batch admitted by age or backlog cap.
    let cutoff = (chrono::Utc::now() - chrono::Duration::hours(48))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let deferred: bool = db.query_row("SELECT COUNT(*)=2 AND COUNT(DISTINCT u.source_role)=2 AND MIN(u.source_role IN ('user','assistant') AND u.record_kind='episode' AND u.state='pending' AND u.attempt_count=0 AND u.error_code IS NULL AND length(u.projection_text)>0 AND j.created_at>?2) FROM memory_vector_units u JOIN memory_projection_jobs j ON j.job_id=u.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id WHERE c.source_key=?1", rusqlite::params![format!("conversation_turn:{turn}"), cutoff], |row| row.get(0)).unwrap();
    let active: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM memory_vector_units WHERE state='running' OR state='failed'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let pending: usize = db
        .query_row(
            "SELECT COUNT(*) FROM memory_vector_units WHERE state='pending'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    // Semantic/cache receipts precede the separate multilingual FTS drain.
    // Include its committed pending work and migration cursor in quiescence;
    // the unchanged idle window must cover no delayed background writes.
    let fts_complete: bool = db.query_row("SELECT NOT EXISTS(SELECT 1 FROM memory_episode_fts_pending) AND NOT EXISTS(SELECT 1 FROM memory_state WHERE key='episode_fts_script_cursor') AND EXISTS(SELECT 1 FROM memory_state WHERE key='episode_fts_script_seeded') AND EXISTS(SELECT 1 FROM memory_state WHERE key='episode_fts_trigger_version' AND value='2')", [], |row| row.get(0)).unwrap();
    complete == 1
        && deferred
        && fts_complete
        && active == 0
        && pending <= 1_024
        // Graph/cache commits precede the writer lease's final COMMIT/close.
        // Its DELETE journal must be removed before the idle window begins.
        && !data.join("cognition/consolidation/locks/consolidation.lock.coord.sqlite-journal").exists()
        && fs::read_to_string(data.join("cognition/memory/queue/sync.jsonl"))
            .is_ok_and(|text| text.trim().is_empty())
}

pub(super) async fn assert_idle(s: &Scenario, turn: &str) -> Result<(), HarnessError> {
    // Delivery precedes memory registration/projection and fresh startup work.
    // Preserve all of that work; start the unchanged 10s zero-write window only
    // after the turn is projected/cached and its complete vector inputs are
    // durably deferred without an embedding worker.
    // Queue acknowledgement and semantic/cache completion can precede the
    // canonical catch-up receipt and cursor commit. They are durable work too.
    // Require this turn's complete reconciliation before measuring zero writes.
    let mut waited_for_catchup = false;
    let readiness = until(|| {
        if !settled(&s.sandbox.data, turn) {
            return false;
        }
        let ready = catchup::settled(&s.sandbox.data, turn);
        waited_for_catchup |= !ready;
        ready
    })
    .await;
    if readiness.is_err() {
        eprintln!(
            "idle readiness timeout: base_settled={} canonical_flags={:?}",
            settled(&s.sandbox.data, turn),
            catchup::status(&s.sandbox.data, turn)
        );
    }
    readiness?;
    eprintln!("idle barrier: waited_for_canonical_catchup={waited_for_catchup}");
    let messages = s.gw.messages("general").await?;
    let record = instance_record(&s.sandbox.data).unwrap();
    let pids = ["pid", "cli_supervisor_pid"]
        .map(|key| u32::try_from(record[key].as_u64().unwrap()).unwrap());
    assert_no_embedding_worker(pids[0])?;
    let before_files = stamps(&s.sandbox.data)?;
    let before = pids.map(|pid| usage::sample(pid).unwrap());
    tokio::time::sleep(Duration::from_secs(10)).await;
    let after = pids.map(|pid| usage::sample(pid).unwrap());
    let after_files = stamps(&s.sandbox.data)?;
    assert!(
        settled(&s.sandbox.data, turn) && catchup::settled(&s.sandbox.data, turn),
        "deferred memory content changed"
    );
    assert_no_embedding_worker(pids[0])?;
    let changed: Vec<_> = before_files
        .keys()
        .chain(after_files.keys())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter(|path| before_files.get(*path) != after_files.get(*path))
        .map(|path| path.strip_prefix(&s.sandbox.data).unwrap())
        .collect();
    eprintln!("idle changed files: {changed:?}");
    for i in 0..2 {
        if let (Some(before), Some(after)) = (&before[i], &after[i]) {
            let bytes = after.write_bytes - before.write_bytes;
            let chars = after
                .write_chars
                .zip(before.write_chars)
                .map(|(a, b)| a - b);
            eprintln!(
                "idle pid={} window=10s write_bytes={bytes} write_chars={chars:?}",
                pids[i]
            );
            assert_eq!(bytes, 0, "idle service storage writes; changed={changed:?}");
        }
    }
    assert_eq!(after_files, before_files, "idle buffered file writes");
    eprintln!("idle window=10s modified_files=0 log_bytes_written=0");
    assert_eq!(
        s.gw.messages("general").await?,
        messages,
        "idle changed session content"
    );
    Ok(())
}

fn assert_no_embedding_worker(pid: u32) -> Result<(), HarnessError> {
    if let Some(workers) = butler_platform::process_control::usage::embedding_children(pid)? {
        assert!(
            workers.is_empty(),
            "cold diagnostic turn loaded embedding worker"
        );
    }
    Ok(())
}

fn stamps(root: &Path) -> Result<BTreeMap<PathBuf, (u64, SystemTime)>, HarnessError> {
    let mut files = BTreeMap::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            files.extend(stamps(&entry.path())?);
        } else {
            // Directory enumeration caches NTFS attributes. Query the open
            // file handle so prior writes cannot appear as new idle writes.
            let metadata = fs::File::open(entry.path())?.metadata()?;
            files.insert(entry.path(), (metadata.len(), metadata.modified()?));
        }
    }
    Ok(files)
}
