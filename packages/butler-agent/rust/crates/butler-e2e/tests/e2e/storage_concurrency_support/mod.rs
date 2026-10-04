#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "E2E fixture assertions shared by the integration scenarios"
)]
use rusqlite::{Connection, params};
use serde_json::Value;
use std::path::Path;

pub(super) fn seed(path: &Path) {
    let db = butler_platform::sqlite::open(path).unwrap();
    db.execute_batch(
        "PRAGMA synchronous=OFF; BEGIN;
      WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<599)
      INSERT INTO chats(id,title,kind,pinned,archived,created_at,updated_at)
      SELECT 'scale-c'||i,'Scale','chat',0,0,'2026-01-01','2026-01-01' FROM n;
      WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<299999)
      INSERT INTO events(type,turn_id,payload_json,created_at)
      SELECT 'seed','',json_object('text',hex(zeroblob(2048))),'2026-01-01' FROM n;
      COMMIT; PRAGMA wal_checkpoint(TRUNCATE);",
    )
    .unwrap();
    let events: u64 = db
        .query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))
        .unwrap();
    assert!(events >= 300_000);
    assert!(std::fs::metadata(path).unwrap().len() >= 1_300_000_000);
}

pub(super) fn verify_rows(
    path: &Path,
    sessions: &[String],
    turns: &[String],
    deltas: usize,
    request: &str,
    answer: &str,
) {
    let db = butler_platform::sqlite::open(path).unwrap();
    for (session, turn) in sessions.iter().zip(turns) {
        let mut query = db
            .prepare("SELECT role,text FROM messages WHERE chat_id=?1 ORDER BY rowid")
            .unwrap();
        let rows = query
            .query_map([session], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].0, "user");
        assert_eq!(rows[0].1, request);
        assert_eq!(rows[1], ("assistant".to_owned(), answer.to_owned()));
        let mut events = db.prepare("SELECT payload_json FROM events WHERE turn_id=?1 AND type='agent.turn_event' ORDER BY id").unwrap();
        let values = events
            .query_map(params![turn], |row| row.get::<_, String>(0))
            .unwrap()
            .map(|row| serde_json::from_str::<Value>(&row.unwrap()).unwrap())
            .collect::<Vec<_>>();
        let sequences = values
            .iter()
            .filter(|v| v["event"]["kind"] == "model.stream.text_delta")
            .map(|v| v["event"]["turnSequence"].as_u64().unwrap())
            .collect::<Vec<_>>();
        assert!(sequences.windows(2).all(|pair| pair[0] < pair[1]));
        let texts = values
            .iter()
            .filter(|v| v["event"]["kind"] == "model.stream.text_delta")
            .map(|v| v["event"]["payload"]["textDelta"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(texts.len(), deltas);
        assert_eq!(texts.concat().trim_end(), answer);
        verify_message_updates(&db, turn, &texts);
        assert!(
            values
                .iter()
                .any(|v| v["event"]["kind"] == "turn.completed")
        );
    }
}

fn verify_message_updates(db: &Connection, turn: &str, deltas: &[&str]) {
    let mut query = db.prepare("SELECT payload_json,created_at FROM events WHERE turn_id=?1 AND type='message.updated' ORDER BY id").unwrap();
    let updates = query
        .query_map([turn], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(updates.len(), deltas.len());
    let mut text = String::new();
    let mut identity = None;
    for ((payload, created_at), delta) in updates.iter().zip(deltas) {
        text.push_str(delta);
        let mut message = serde_json::from_str::<Value>(payload).unwrap()["message"].clone();
        assert_eq!(message["text"], text);
        assert_eq!(message["updated_at"], *created_at);
        assert_eq!(message["role"], "assistant");
        assert_eq!(message["status"], "streaming");
        let fields = message.as_object_mut().unwrap();
        fields.remove("text");
        fields.remove("updated_at");
        match &identity {
            Some(expected) => assert_eq!(&message, expected),
            None => identity = Some(message),
        }
    }
}

/// Every boundary case reads the same full skill fact through the public view.
pub(super) async fn verify_skill_record_boundaries(
    s: &butler_e2e::e2e::scenario::Scenario,
    path: &std::path::Path,
    event: &serde_json::Value,
) -> Result<(), butler_e2e::e2e::HarnessError> {
    let expected =
        serde_json::Value::Array(vec![event["payload"]["details"]["skillNames"][0].clone()]);
    let mut padded = event.clone();
    padded["padding"] = serde_json::Value::String("x".repeat(70_000));
    let record = padded.to_string();
    // Cross multiple 32KiB reads, with and without a final newline.
    for suffix in ["", "\n"] {
        std::fs::write(path, format!("{record}{suffix}"))?;
        let view = s.gw.get("/session-view?session_id=general").await?;
        assert_eq!(view.status, 200);
        assert_eq!(view.data()["skills_used"], expected);
    }
    // An oversized newer record must not hide the earlier complete fact.
    padded["padding"] = serde_json::Value::String("x".repeat(1024 * 1024));
    std::fs::write(path, format!("{event}\n{padded}\n"))?;
    let view = s.gw.get("/session-view?session_id=general").await?;
    assert_eq!(view.status, 200);
    assert_eq!(view.data()["skills_used"], expected);
    Ok(())
}
