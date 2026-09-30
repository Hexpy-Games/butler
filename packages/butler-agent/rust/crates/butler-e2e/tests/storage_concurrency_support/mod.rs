use rusqlite::{Connection, params};
use serde_json::Value;
use std::path::Path;

pub(super) fn seed(path: &Path) {
    let db = Connection::open(path).unwrap();
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
    answer: &str,
) {
    let db = Connection::open(path).unwrap();
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
        assert!(
            values
                .iter()
                .any(|v| v["event"]["kind"] == "turn.completed")
        );
    }
}
