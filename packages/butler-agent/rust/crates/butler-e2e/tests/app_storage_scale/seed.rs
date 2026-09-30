//! Shared PERF-01 owner-scale App seed.

use rusqlite::Connection;

const CHATS: u32 = 500;
const TURNS: u32 = 5_000;
/// The newest turns, still holding their progress events.
pub(super) const UNCOMPACTED: u32 = 100;
const PROGRESS_EVENTS: u32 = 30;
/// Events per compacted turn; with the progress events, about 200k in all.
const TURN_EVENTS: u32 = 40;
pub(super) const SEEDED_AT: &str = "2000-01-01 00:00:00";

/// Seeds the owner-scale shape: `TURNS` terminal turns over `CHATS` chats whose
/// projections exist, except the first `UNCOMPACTED`, which still hold their
/// progress events and need compaction.
pub(super) fn seed_owner_scale(db: &Connection, blob_bytes: usize) {
    db.execute_batch(
        "PRAGMA synchronous=OFF; BEGIN;
         WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<499)
         INSERT INTO chats(id,title,kind,pinned,archived,created_at,updated_at)
           SELECT 'perf-c'||i,'Chat '||i,'chat',0,0,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z' FROM n;
         WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<4999)
         INSERT INTO turns(id,chat_id,state,safe_status_label,created_at,updated_at)
           SELECT 'perf-t'||i,'perf-c'||(i%500),'delivered','Delivered',
                  '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z' FROM n;",
    )
    .unwrap();
    seed_events(db, blob_bytes);
    db.execute_batch(&format!(
        "INSERT INTO app_terminal_turn_projections(turn_id,chat_id,terminal_state,
           progress_rows_json,delivery_metadata_json,source_event_high_water,compacted_at)
           SELECT t.id,t.chat_id,'delivered','[]',NULL,
                  (SELECT MAX(id) FROM events e WHERE e.turn_id=t.id AND e.turn_id<>''),'{SEEDED_AT}'
           FROM turns t WHERE {compacted};
         WITH RECURSIVE k(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM k WHERE i<4)
         INSERT INTO app_terminal_turn_progress_rows(turn_id,source_event_id,row_json)
           SELECT t.id,10000000+t.rowid*10+k.i,'{{\"id\":\"row\",\"kind\":\"used_tool\"}}'
           FROM turns t, k WHERE {compacted};
         COMMIT;",
        compacted = compacted_turns(),
    ))
    .unwrap();
}

/// The events: progress rows of the uncompacted turns first (the oldest, so
/// outside the replay tail), then every turn's ordinary turn events.
fn seed_events(db: &Connection, blob_bytes: usize) {
    let text = format!("hex(zeroblob({blob_bytes}))");
    db.execute_batch(&format!(
        "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<{last})
         INSERT INTO events(type,turn_id,payload_json,created_at)
           SELECT 'progress.summary','perf-t'||(i/{PROGRESS_EVENTS}),
             json_object('session_id','perf-c'||((i/{PROGRESS_EVENTS})%{CHATS}),
               'turn_id','perf-t'||(i/{PROGRESS_EVENTS}),
               'row',json_object('id','row-'||i,'kind','used_tool','state','running',
                 'safe_label',{text})),
             '2026-01-01T00:00:00.000Z' FROM n;
         WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<{turn_last})
         INSERT INTO events(type,turn_id,payload_json,created_at)
           SELECT 'agent.turn_event','perf-t'||(i/{TURN_EVENTS}),
             json_object('session_id','perf-c'||((i/{TURN_EVENTS})%{CHATS}),
               'turn_id','perf-t'||(i/{TURN_EVENTS}),
               'event',json_object('kind',
                 CASE WHEN i%{TURN_EVENTS}={TURN_EVENTS}-1 THEN 'turn.completed'
                      ELSE 'tool.progress' END,
                 'payload',json_object('text',{text}))),
             '2026-01-01T00:00:00.000Z' FROM n;",
        last = UNCOMPACTED * PROGRESS_EVENTS - 1,
        turn_last = TURNS * TURN_EVENTS - 1,
    ))
    .unwrap();
}

/// SQL over `turns t`: the seeded turns whose projections already exist.
fn compacted_turns() -> String {
    format!("t.id LIKE 'perf-t%' AND CAST(substr(t.id,7) AS INTEGER)>={UNCOMPACTED}")
}
