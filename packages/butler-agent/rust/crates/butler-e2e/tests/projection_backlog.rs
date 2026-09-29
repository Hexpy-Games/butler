//! A large transcript is projected in linear time and memory (regression:
//! the native cutover re-stored the whole unread rest of the file in the
//! checkpoint after every record, so a 70 MB transcript grew an 85 MB row and
//! kept the idle agent at 100-200% CPU).
//!
//! The transcript is synthetic. The checkpoint row is seeded the way the
//! cutover left it: partly read, with megabytes of the following bytes stored
//! as `trailing`. The agent must repair it on upgrade without manual edits.
//!
//! A checkpoint recorded under another device id (macOS renumbers devices
//! across boots) must still resume at its recorded offset: judged foreign, a
//! finished transcript was projected again from byte zero.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::fmt::Write as _;
use std::path::Path;
use std::time::{Duration, Instant};

use base64::{Engine, engine::general_purpose::STANDARD};
use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::gateway::turn_state;
use butler_e2e::e2e::scenario::{Scenario, Setup};
use rusqlite::{Connection, OpenFlags, params};
use serde_json::json;

const CHAT: &str = "general";
const TRANSCRIPT: &str = "transcripts/butler_app-general.jsonl";
const DATABASE: &str = "app-server/butler-client.sqlite";
const RECORDS: usize = 8_000;
const SMALL_RECORDS: usize = 400;
const FILLER_BYTES: usize = 2_400;
/// The record before which the seeded checkpoint stands.
const SEEDED_AT: usize = 2_000;
const LEGACY_TRAILING_BYTES: usize = 8 * 1024 * 1024;
/// Two 64 KiB windows as base64: far below the legacy row, above what the
/// agent ever keeps.
const TRAILING_LIMIT_CHARS: i64 = 2 * 64 * 1024 * 4 / 3 + 4;
const DEADLINE: Duration = Duration::from_secs(150);

fn is_action(index: usize) -> bool {
    index % 100 == 7
}

/// One transcript line: every hundredth record is an App outbound with an
/// action id (projection stages it); the rest are records projection skips.
fn record(index: usize) -> String {
    let filler = "x".repeat(FILLER_BYTES);
    let common = json!({"eventId": format!("event-{index}"), "sessionId": "butler/app-general",
        "timestamp": "2026-01-01T00:00:00.000Z"});
    let mut event = common.as_object().unwrap().clone();
    if is_action(index) {
        event.insert("kind".into(), json!("outbound"));
        event.insert("transport".into(), json!("app"));
        event.insert(
            "payload".into(),
            json!({"actionId": format!("action-{index}"), "text": filler}),
        );
    } else {
        event.insert("kind".into(), json!("inbound"));
        event.insert("transport".into(), json!("telegram"));
        event.insert("payload".into(), json!({"text": filler}));
    }
    format!("{}\n", serde_json::Value::Object(event))
}

/// Writes a transcript of `records` records; returns its bytes and the offset
/// of record `SEEDED_AT`.
fn write_transcript(data: &Path, records: usize) -> (Vec<u8>, usize) {
    let mut text = String::new();
    let mut seeded = 0;
    for index in 0..records {
        if index == SEEDED_AT {
            seeded = text.len();
        }
        write!(text, "{}", record(index)).unwrap();
    }
    let path = data.join(TRANSCRIPT);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, &text).unwrap();
    (text.into_bytes(), seeded)
}

/// Stores a checkpoint at `at` holding `trailing`, under a device and inode
/// number `id_shift` away from the file's own.
fn seed_checkpoint(data: &Path, bytes: &[u8], at: usize, trailing: &[u8], id_shift: u64) {
    let path = data.join(TRANSCRIPT);
    let (device, inode) = file_ids(&path);
    let db = Connection::open(data.join(DATABASE)).unwrap();
    db.execute(
        "INSERT OR REPLACE INTO app_transcript_projection_checkpoints(chat_id,session_id,\
         transcript_path,file_device,file_inode,projected_bytes,modified_at_ms,trailing_text,\
         boundary_anchor_text,updated_at) VALUES(?1,'butler/app-general',?2,?3,?4,?5,0,?6,?7,'now')",
        params![
            CHAT,
            path.to_string_lossy(),
            device + id_shift,
            inode + id_shift,
            at,
            STANDARD.encode(trailing),
            STANDARD.encode(&bytes[at - 64..at])
        ],
    )
    .unwrap();
}

fn file_ids(path: &Path) -> (u64, u64) {
    let identity = butler_platform::secure_fs::identity(&std::fs::metadata(path).unwrap());
    identity.id.map_or((0, 0), |id| (id.device, id.inode))
}

fn read_only(data: &Path) -> Connection {
    Connection::open_with_flags(data.join(DATABASE), OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap()
}

/// `(projected_bytes, trailing characters)` of the chat's checkpoint.
fn checkpoint(db: &Connection) -> Option<(i64, i64)> {
    db.query_row(
        "SELECT projected_bytes,length(trailing_text) FROM app_transcript_projection_checkpoints \
         WHERE chat_id=?1",
        [CHAT],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .ok()
}

/// Waits until the checkpoint reaches the end of the transcript; returns the
/// largest trailing text seen once the seeded row had been replaced, and the
/// time taken.
async fn wait_projected(
    s: &Scenario,
    size: usize,
    seeded: usize,
) -> Result<(i64, Duration), HarnessError> {
    let (size, seeded) = (i64::try_from(size).unwrap(), i64::try_from(seeded).unwrap());
    let started = Instant::now();
    let mut largest = 0;
    loop {
        let found = checkpoint(&read_only(&s.sandbox.data));
        if let Some((projected, trailing)) = found {
            if projected > seeded {
                largest = largest.max(trailing);
            }
            if projected == size {
                return Ok((largest, started.elapsed()));
            }
        }
        assert!(
            started.elapsed() < DEADLINE,
            "transcript not projected in {DEADLINE:?}; checkpoint {found:?}"
        );
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

fn staged_actions(data: &Path) -> Vec<String> {
    let db = read_only(data);
    let mut statement = db
        .prepare(
            "SELECT action_id FROM app_transport_projection_staged_outbounds ORDER BY action_id",
        )
        .unwrap();
    statement
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

/// PROJ-BACKLOG — A 20 MB transcript with an oversized legacy checkpoint is
/// projected to its end in bounded time, the checkpoint keeps at most a
/// couple of windows, and every record after the seeded position is projected
/// exactly once (the records before it are not read again).
#[tokio::test]
async fn proj_backlog_large_transcript_projects_in_bounded_time_and_space()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("PROJ-BACKLOG")?.start().await?;
    s.agent.terminate().await?;
    let (bytes, seeded) = write_transcript(&s.sandbox.data, RECORDS);
    assert!(
        bytes.len() > 19_000_000,
        "transcript is {} bytes",
        bytes.len()
    );
    seed_checkpoint(
        &s.sandbox.data,
        &bytes,
        seeded,
        &bytes[seeded..seeded + LEGACY_TRAILING_BYTES],
        0,
    );
    s.gw = s.agent.start_again().await?;

    let (largest, took) = wait_projected(&s, bytes.len(), seeded).await?;
    eprintln!("PROJ-BACKLOG projected {} bytes in {took:?}", bytes.len());
    assert!(
        largest <= TRAILING_LIMIT_CHARS,
        "checkpoint kept {largest} characters of trailing text"
    );

    let mut expected: Vec<String> = (SEEDED_AT..RECORDS)
        .filter(|index| is_action(*index))
        .map(|index| format!("action-{index}"))
        .collect();
    expected.sort();
    assert_eq!(staged_actions(&s.sandbox.data), expected);
    s.finish().await
}

/// PROJ-DEVICE — A finished transcript whose checkpoint names another device
/// and inode is not projected again: the agent resumes at the recorded offset
/// (the bytes before it still match) and records the file's current ids.
#[tokio::test]
async fn proj_device_change_resumes_at_the_recorded_offset() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("PROJ-DEVICE")?.start().await?;
    s.agent.terminate().await?;
    let (bytes, _) = write_transcript(&s.sandbox.data, SMALL_RECORDS);
    seed_checkpoint(&s.sandbox.data, &bytes, bytes.len(), &[], 1);
    s.gw = s.agent.start_again().await?;

    let (device, _) = file_ids(&s.sandbox.data.join(TRANSCRIPT));
    let started = Instant::now();
    loop {
        let stored: Option<(i64, i64)> = read_only(&s.sandbox.data)
            .query_row(
                "SELECT file_device,projected_bytes FROM app_transcript_projection_checkpoints \
                 WHERE chat_id=?1",
                [CHAT],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();
        if stored.is_some_and(|(seen, _)| seen == i64::try_from(device).unwrap()) {
            assert_eq!(stored.map(|(_, at)| at), i64::try_from(bytes.len()).ok());
            break;
        }
        assert!(started.elapsed() < DEADLINE, "checkpoint not revisited");
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert_eq!(staged_actions(&s.sandbox.data), Vec::<String>::new());
    s.finish().await
}

const SIDE_CHATS: [&str; 3] = ["side-1", "side-2", "side-3"];
const NUMBERS: &str = "Write the numbers from one to twelve as English words, separated by single spaces, and nothing else.";

/// `(chat, updated_at)` of the side chats' checkpoints once all are projected.
async fn side_checkpoints(s: &Scenario) -> Result<Vec<(String, String)>, HarnessError> {
    let started = Instant::now();
    loop {
        let db = read_only(&s.sandbox.data);
        let mut statement = db
            .prepare(
                "SELECT chat_id,updated_at FROM app_transcript_projection_checkpoints \
                 WHERE chat_id LIKE 'side-%' AND projected_bytes>0 ORDER BY chat_id",
            )
            .unwrap();
        let rows: Vec<(String, String)> = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        if rows.len() == SIDE_CHATS.len() {
            return Ok(rows);
        }
        assert!(started.elapsed() < DEADLINE, "side chats not projected");
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// PROJ-TERMINAL — A turn that settles in one chat does not sweep, or rewrite
/// the checkpoints of, the other chats.
#[tokio::test]
async fn proj_terminal_settle_leaves_unrelated_checkpoints_alone() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("PROJ-TERMINAL")?
        .cassette("TURN-01")
        .replay_only()
        .start()
        .await?;
    s.agent.terminate().await?;
    let db = Connection::open(s.sandbox.data.join(DATABASE)).unwrap();
    for chat in SIDE_CHATS {
        db.execute(
            "INSERT INTO chats(id,title,kind,created_at,updated_at) \
             VALUES(?1,'side','chat','now','now')",
            [chat],
        )
        .unwrap();
        // Records projection skips: none is an App outbound.
        let lines: String = (0..5).map(|index| record(index + 1)).collect();
        let file = format!("transcripts/butler_app-{chat}.jsonl");
        std::fs::write(s.sandbox.data.join(file), lines).unwrap();
    }
    drop(db);
    s.gw = s.agent.start_again().await?;
    let before = side_checkpoints(&s).await?;

    let (_, turn) = s.turn("general", NUMBERS).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(side_checkpoints(&s).await?, before);
    s.finish().await
}
