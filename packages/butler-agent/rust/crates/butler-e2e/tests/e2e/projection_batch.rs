//! A burst of transcript records is projected in one pass, so one App
//! transaction (#1036: each record waited for its own commit, and on a slow
//! disk every commit waited for a checkpoint pass).
//!
//! The records are synthetic App transport records the projection records
//! without a turn: staged outbounds, failed deliveries that retire them,
//! records it only steps over, and a blank line. The App state after the
//! burst, its order and the cursor must be exactly what one-record passes
//! produced, also after the agent is killed inside the batch's transaction
//! or right after its commit.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::path::Path;
use std::time::{Duration, Instant};

use base64::{Engine, engine::general_purpose::STANDARD};
use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::scenario::{Scenario, Setup};
use butler_platform::sqlite;
use rusqlite::OpenFlags;
use serde_json::{Value, json};

const DATABASE: &str = "app-server/butler-client.sqlite";
const RECORDS: usize = 24;
const DEADLINE: Duration = Duration::from_secs(60);

/// The burst for `chat`: every sixth line a record projection steps over,
/// every sixth a blank line, every sixth a failed delivery of the outbound
/// before it, and App outbounds otherwise.
fn burst(chat: &str) -> (String, Vec<Value>) {
    let session = format!("butler/app-{chat}");
    let (mut text, mut staged) = (String::new(), Vec::new());
    for index in 0..RECORDS {
        let action = format!("{chat}-action-{index}");
        let common = json!({"eventId": format!("{chat}-event-{index}"), "sessionId": session,
            "timestamp": format!("2026-10-16T00:00:{index:02}.000Z")});
        let mut record = common.as_object().unwrap().clone();
        match index % 6 {
            0 => {
                record.insert("kind".into(), json!("inbound"));
                record.insert("transport".into(), json!("app"));
                record.insert("payload".into(), json!({"text": format!("hello {index}")}));
            }
            3 => {
                text.push_str("  \n");
                continue;
            }
            5 => {
                let failed = format!("{chat}-action-{}", index - 1);
                record.insert("kind".into(), json!("delivery"));
                record.insert("transport".into(), json!("app"));
                record.insert("payload".into(), json!({"actionId": failed, "ok": false}));
                staged.retain(|event: &Value| event["payload"]["actionId"] != json!(failed));
            }
            _ => {
                record.insert("kind".into(), json!("outbound"));
                record.insert("transport".into(), json!("app"));
                record.insert(
                    "payload".into(),
                    json!({"actionId": action, "message": {"text": format!("record {index}")}}),
                );
                staged.push(Value::Object(record.clone()));
            }
        }
        text.push_str(&Value::Object(record).to_string());
        text.push('\n');
    }
    (text, staged)
}

fn read_only(data: &Path) -> sqlite::Connection {
    sqlite::open_with_flags(data.join(DATABASE), OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap()
}

/// Adds `chat` and writes its transcript while the agent is stopped.
fn seed(data: &Path, chat: &str, text: &str) {
    let db = sqlite::open(data.join(DATABASE)).unwrap();
    db.execute(
        "INSERT INTO chats(id,title,kind,created_at,updated_at) VALUES(?1,'burst','chat','now','now')",
        [chat],
    )
    .unwrap();
    std::fs::write(
        data.join("transcripts")
            .join(format!("butler_app-{chat}.jsonl")),
        text,
    )
    .unwrap();
}

/// `(projected_bytes, trailing, anchor)` of `chat`'s checkpoint.
fn cursor(data: &Path, chat: &str) -> Option<(usize, String, String)> {
    read_only(data)
        .query_row(
            "SELECT projected_bytes,trailing_text,boundary_anchor_text \
             FROM app_transcript_projection_checkpoints WHERE chat_id=?1",
            [chat],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .ok()
}

/// The staged outbounds of `chat` in the order they were recorded.
fn staged(data: &Path, chat: &str) -> Vec<Value> {
    let db = read_only(data);
    let mut statement = db
        .prepare(
            "SELECT event_json FROM app_transport_projection_staged_outbounds \
             WHERE chat_id=?1 ORDER BY rowid",
        )
        .unwrap();
    statement
        .query_map([chat], |row| row.get::<_, String>(0))
        .unwrap()
        .map(|json| serde_json::from_str(&json.unwrap()).unwrap())
        .collect()
}

async fn wait_projected(s: &Scenario, chat: &str, size: usize) {
    let started = Instant::now();
    while cursor(&s.sandbox.data, chat).is_none_or(|(at, _, _)| at != size) {
        assert!(started.elapsed() < DEADLINE, "{chat} was not projected");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Every record projected once, in file order, and the cursor at the end of
/// the transcript with the file's own last bytes as its anchor.
fn assert_projected(data: &Path, chat: &str, text: &str, expected: &[Value]) {
    let (at, trailing, anchor) = cursor(data, chat).unwrap();
    assert_eq!(at, text.len());
    assert_eq!(trailing, "");
    assert_eq!(anchor, STANDARD.encode(&text.as_bytes()[text.len() - 64..]));
    let stored = staged(data, chat);
    let fields = |event: &Value| {
        json!([
            event["eventId"],
            event["sessionId"],
            event["kind"],
            event["transport"],
            event["timestamp"],
            event["payload"]
        ])
    };
    assert_eq!(
        stored.iter().map(fields).collect::<Vec<_>>(),
        expected.iter().map(fields).collect::<Vec<_>>()
    );
}

/// Projection passes that recorded transcript records in `logs`.
fn passes(logs: &str) -> usize {
    logs.lines()
        .filter(|line| {
            line.contains("command_gateway_timing phase=projection_record ")
                && line.contains(" event=event_projected ")
        })
        .count()
}

/// PROJ-BATCH — a burst of records is projected in one pass, and so in one
/// App transaction, with the same content, order and cursor.
#[tokio::test]
async fn proj_batch_burst_projects_in_one_pass() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("PROJ-BATCH")?.start().await?;
    s.agent.terminate().await?;
    let (text, expected) = burst("burst");
    seed(&s.sandbox.data, "burst", &text);
    s.agent.launch.set_env("BUTLER_DEBUG_COMMAND_TIMINGS", "1");
    let earlier = s.agent.logs().len();
    s.gw = s.agent.start_again().await?;
    wait_projected(&s, "burst", text.len()).await;
    assert_projected(&s.sandbox.data, "burst", &text, &expected);
    let passes = passes(&s.agent.logs()[earlier..]);
    eprintln!("PROJ-BATCH {RECORDS} records projected in {passes} pass(es)");
    assert_eq!(passes, 1, "one pass, one App transaction, for the burst");
    s.finish().await
}

/// PROJ-BATCH-CRASH — the agent killed inside the batch's App transaction, or
/// right after it committed, projects every record exactly once after the
/// restart, in order, with the cursor at the end of the transcript.
#[tokio::test]
async fn proj_batch_crash_reprojects_without_loss_or_duplication() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("PROJ-BATCH-CRASH")?.start().await?;
    for (chat, point, committed) in [
        ("uncommitted", "app_projection_batch_uncommitted", false),
        ("committed", "app_projection_batch_committed", true),
    ] {
        s.agent.terminate().await?;
        let (text, expected) = burst(chat);
        seed(&s.sandbox.data, chat, &text);
        s.agent.launch.set_env("BUTLER_E2E_ABORT_POINT", point);
        // The abort can come before or after the agent reports ready.
        let _ = s.agent.start_again().await;
        let started = Instant::now();
        while s.agent.is_running() {
            assert!(started.elapsed() < DEADLINE, "did not abort at {point}");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        s.agent.reap();
        if committed {
            assert_projected(&s.sandbox.data, chat, &text, &expected);
        } else {
            assert_eq!(cursor(&s.sandbox.data, chat), None, "{point}");
            assert_eq!(
                staged(&s.sandbox.data, chat),
                Vec::<Value>::new(),
                "{point}"
            );
        }
        s.agent.launch.remove_env("BUTLER_E2E_ABORT_POINT");
        s.gw = s.agent.start_again().await?;
        wait_projected(&s, chat, text.len()).await;
        assert_projected(&s.sandbox.data, chat, &text, &expected);
    }
    s.finish().await
}
