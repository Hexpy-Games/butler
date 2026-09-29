//! IDLE-DISK: sustained background work cannot burn SSD writes or CPU.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use butler_e2e::e2e::gateway::turn_state;
use butler_e2e::e2e::scenario::Setup;
use butler_e2e::e2e::{HarnessError, harness_error};
use butler_platform::process_usage;
use rusqlite::{Connection, params};
use serde_json::json;

const IDLE: Duration = Duration::from_secs(60);
const AFTER_TURN: Duration = Duration::from_secs(30);
const GRACE: Duration = Duration::from_secs(5);
const IDLE_WRITE_LIMIT: u64 = 1_000_000;
const TURN_WRITE_LIMIT: u64 = 5_000_000;
const CPU_LIMIT_PERCENT: f64 = 2.0;
const NUMBERS: &str = "Write the numbers from one to twelve as English words, separated by single spaces, and nothing else.";

/// A bounded but diverse installed history: chat rows, completed turns,
/// transcript files, terminal command turns, and existing memory files.
fn seed(data: &Path) -> Result<usize, HarnessError> {
    let mut db = Connection::open(data.join("app-server/butler-client.sqlite"))
        .map_err(|error| harness_error(error.to_string()))?;
    let transaction = db
        .transaction()
        .map_err(|error| harness_error(error.to_string()))?;
    fs::create_dir_all(data.join("transcripts"))?;
    let mut transcript_bytes = 0;
    for chat in 0..64 {
        let id = format!("idle-{chat:03}");
        transaction.execute(
            "INSERT INTO chats(id,title,kind,created_at,updated_at) VALUES(?1,?2,'chat','2026-01-01','2026-01-01')",
            params![id, format!("Idle chat {chat}")],
        ).map_err(|error| harness_error(error.to_string()))?;
        for turn in 0..8 {
            let turn_id = format!("{id}-turn-{turn}");
            transaction.execute(
                "INSERT INTO turns(id,chat_id,state,safe_status_label,retryable,cancellable,created_at,updated_at) \
                 VALUES(?1,?2,'delivered','Delivered',0,0,'2026-01-01','2026-01-01')",
                params![turn_id, id],
            ).map_err(|error| harness_error(error.to_string()))?;
            transaction.execute(
                "INSERT INTO messages(id,chat_id,turn_id,role,text,status,created_at,updated_at) \
                 VALUES(?1,?2,?3,'assistant',?4,'complete','2026-01-01','2026-01-01')",
                params![format!("{turn_id}-message"), id, turn_id, "Synthetic completed answer. ".repeat(30)],
            ).map_err(|error| harness_error(error.to_string()))?;
        }
        let transcript = (0..24)
            .map(|turn| {
                json!({"eventId":format!("{id}-{turn}"),"sessionId":format!("butler/app-{id}"),
                "timestamp":"2026-01-01T00:00:00.000Z","kind":"inbound","transport":"app",
                "payload":{"text":format!("Synthetic terminal turn {turn}: {}", "x".repeat(400))}})
                .to_string()
                    + "\n"
            })
            .collect::<String>();
        transcript_bytes = transcript.len();
        fs::write(
            data.join(format!("transcripts/butler_app-{id}.jsonl")),
            transcript,
        )?;
    }
    transaction
        .commit()
        .map_err(|error| harness_error(error.to_string()))?;
    let memory = data.join("cognition/memory/hot");
    fs::create_dir_all(&memory)?;
    for index in 0..32 {
        fs::write(
            memory.join(format!("synthetic-{index:03}.md")),
            format!(
                "# Synthetic memory {index}\n{}",
                "Recorded project detail. ".repeat(100)
            ),
        )?;
    }
    Ok(transcript_bytes)
}

async fn wait_for_projection(data: &Path, transcript_bytes: usize) -> Result<(), HarnessError> {
    let start = Instant::now();
    loop {
        let db = Connection::open(data.join("app-server/butler-client.sqlite"))
            .map_err(|error| harness_error(error.to_string()))?;
        let projected: i64 = db
            .query_row(
                "SELECT count(*) FROM app_transcript_projection_checkpoints \
             WHERE chat_id LIKE 'idle-%' AND projected_bytes >= ?1",
                [transcript_bytes],
                |row| row.get(0),
            )
            .map_err(|error| harness_error(error.to_string()))?;
        if projected == 64 {
            return Ok(());
        }
        assert!(
            start.elapsed() < Duration::from_secs(60),
            "IDLE-DISK only {projected}/64 seeded transcripts projected before idle window"
        );
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

type Files = BTreeMap<PathBuf, (u64, SystemTime)>;

fn files(root: &Path) -> Result<Files, HarnessError> {
    fn visit(root: &Path, dir: &Path, found: &mut Files) -> std::io::Result<()> {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            let meta = entry.metadata()?;
            if meta.is_dir() {
                visit(root, &path, found)?;
            } else if meta.is_file() {
                found.insert(
                    path.strip_prefix(root).unwrap().to_path_buf(),
                    (meta.len(), meta.modified()?),
                );
            }
        }
        Ok(())
    }
    let mut found = Files::new();
    visit(root, root, &mut found)?;
    Ok(found)
}

fn report_changes(before: &Files, after: &Files) {
    for (path, (size, mtime)) in after {
        if before.get(path) != Some(&(*size, *mtime)) {
            let old = before.get(path).copied();
            eprintln!(
                "IDLE-DISK changed {}: {:?} -> ({size} bytes, {mtime:?})",
                path.display(),
                old
            );
        }
    }
    for path in before.keys().filter(|path| !after.contains_key(*path)) {
        eprintln!("IDLE-DISK removed {}", path.display());
    }
}

async fn measure(
    pid: u32,
    data: &Path,
    label: &str,
    window: Duration,
    limit: u64,
    cpu_limit: Option<f64>,
) -> Result<bool, HarnessError> {
    let before_files = files(data)?;
    let before = process_usage::for_pid(pid)?;
    let start = Instant::now();
    tokio::time::sleep(window).await;
    let elapsed = start.elapsed();
    let after = process_usage::for_pid(pid)?;
    let after_files = files(data)?;
    let writes = after.written_bytes.saturating_sub(before.written_bytes);
    let reads = after.read_bytes.saturating_sub(before.read_bytes);
    let cpu = after.cpu_time.saturating_sub(before.cpu_time);
    let percent = 100.0 * cpu.as_secs_f64() / elapsed.as_secs_f64();
    eprintln!(
        "IDLE-DISK {label}: {writes} written bytes, {reads} read bytes, {percent:.2}% CPU over {elapsed:?}"
    );
    let passed = writes <= limit && cpu_limit.is_none_or(|maximum| percent <= maximum);
    if !passed {
        report_changes(&before_files, &after_files);
    }
    Ok(passed)
}

/// Real agent, seeded history, and strict replay provider. The post-turn
/// window begins only after the gateway reports a terminal turn.
#[tokio::test]
async fn idle_disk_writes_and_cpu_stay_bounded() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut scenario = Setup::new("IDLE-DISK")?
        .cassette("TURN-01")
        .replay_only()
        .start()
        .await?;
    scenario.agent.terminate().await?;
    let transcript_bytes = seed(&scenario.sandbox.data)?;
    scenario.gw = scenario.agent.start_again().await?;
    wait_for_projection(&scenario.sandbox.data, transcript_bytes).await?;
    tokio::time::sleep(GRACE).await;
    let pid = scenario.agent.pid().expect("running agent PID");
    let idle_passed = measure(
        pid,
        &scenario.sandbox.data,
        "idle",
        IDLE,
        IDLE_WRITE_LIMIT,
        Some(CPU_LIMIT_PERCENT),
    )
    .await?;
    let (_, turn) = scenario.turn("general", NUMBERS).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let turn_passed = measure(
        pid,
        &scenario.sandbox.data,
        "after turn",
        AFTER_TURN,
        TURN_WRITE_LIMIT,
        None,
    )
    .await?;
    scenario.finish().await?;
    assert!(idle_passed, "IDLE-DISK idle budget exceeded");
    assert!(turn_passed, "IDLE-DISK after-turn budget exceeded");
    Ok(())
}
