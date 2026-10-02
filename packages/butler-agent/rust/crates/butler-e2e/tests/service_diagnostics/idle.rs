//! Measure idle only after startup and the delivered turn's memory work settle.
use butler_e2e::e2e::{HarnessError, scenario::Scenario, stop_intent::instance_record};
use butler_platform::process_control::usage;
use butler_platform::sqlite;
use rusqlite::OpenFlags;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

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
    // MemorySync uses the real SystemIdentity clock, independently of App's
    // fixed stub clock. Include retries due within the measured idle window.
    let through = (chrono::Utc::now() + chrono::Duration::seconds(10))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let runnable: i64 = db.query_row("SELECT COUNT(*) FROM memory_vector_units WHERE state='running' OR (state='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?1))", [through], |row| row.get(0)).unwrap();
    complete == 1
        && runnable == 0
        && fs::read_to_string(data.join("cognition/memory/queue/sync.jsonl"))
            .is_ok_and(|text| text.trim().is_empty())
}

pub(super) async fn assert_idle(s: &Scenario, turn: &str) -> Result<(), HarnessError> {
    // Delivery precedes memory registration/projection and fresh startup work.
    // Preserve all of that work; start the unchanged 10s zero-write window only
    // after the turn is projected/cached and no vector quantum is runnable.
    until(|| settled(&s.sandbox.data, turn)).await?;
    let messages = s.gw.messages("general").await?;
    let record = instance_record(&s.sandbox.data).unwrap();
    let pids = ["pid", "cli_supervisor_pid"]
        .map(|key| u32::try_from(record[key].as_u64().unwrap()).unwrap());
    let before_files = stamps(&s.sandbox.data)?;
    let before = pids.map(|pid| usage::sample(pid).unwrap());
    tokio::time::sleep(Duration::from_secs(10)).await;
    let after = pids.map(|pid| usage::sample(pid).unwrap());
    let after_files = stamps(&s.sandbox.data)?;
    let changed: Vec<_> = after_files
        .iter()
        .filter(|(path, value)| before_files.get(*path) != Some(*value))
        .map(|(path, _)| path.strip_prefix(&s.sandbox.data).unwrap())
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

fn stamps(root: &Path) -> Result<BTreeMap<PathBuf, (u64, SystemTime)>, HarnessError> {
    let mut files = BTreeMap::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            files.extend(stamps(&entry.path())?);
        } else {
            let metadata = entry.metadata()?;
            files.insert(entry.path(), (metadata.len(), metadata.modified()?));
        }
    }
    Ok(files)
}
