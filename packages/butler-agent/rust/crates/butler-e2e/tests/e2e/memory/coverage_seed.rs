//! Canonical seeds for the inventory coverage scenarios, written the way an
//! external writer would: plain SQL against the agent's live store, with
//! the public revision moved as the store's own writers move it.
#![allow(clippy::unwrap_used, reason = "test fixture setup")]

use butler_platform::sqlite;
use rusqlite::{Connection, params};
use serde_json::json;
use std::path::Path;

pub(super) fn session(db: &Connection, id: &str, project: Option<&str>) {
    db.execute(
        "INSERT INTO conversation_sessions(id,project_id,gateway_origin,created_at,updated_at,status,schema_version) \
         VALUES(?1,?2,'app','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','active',6)",
        params![id, project],
    )
    .unwrap();
}

/// One delivered turn `n` of `session`: a user request and a public answer.
pub(super) fn turn(db: &Connection, session: &str, n: u64, text: &str, at: &str) -> String {
    let turn = format!("{session}-turn-{n}");
    db.execute(
        "INSERT INTO conversation_turns(id,session_id,seq,actor,status,started_at,completed_at) \
         VALUES(?1,?2,?3,'user','complete',?4,?4)",
        params![turn, session, n, at],
    )
    .unwrap();
    for (index, role, origin, body) in [
        (0, "user", "user_input", text.to_owned()),
        (1, "assistant", "assistant_public", format!("Noted: {text}")),
    ] {
        let message = format!("{turn}-{role}");
        db.execute(
            "INSERT INTO conversation_messages(id,session_id,turn_id,seq,role,status,visibility,provenance,created_at,origin_kind) \
             VALUES(?1,?2,?3,?4,?5,'complete','user','trusted',?6,?7)",
            params![message, session, turn, n * 2 + index, role, at, origin],
        )
        .unwrap();
        db.execute(
            "INSERT INTO conversation_parts(id,message_id,part_index,kind,content_json,status) \
             VALUES(?1,?2,0,'text',?3,'complete')",
            params![
                format!("{message}-part"),
                message,
                json!({"text": body}).to_string()
            ],
        )
        .unwrap();
    }
    db.execute(
        "INSERT INTO conversation_turn_outcomes(id,session_id,turn_id,generation,outcome,source_hash,request_message_id,\
         public_assistant_message_id,evidence_refs_json,unresolved_obligations_json,created_at) \
         VALUES(?1,?2,?3,1,'delivered','seed',?4,?5,'[]','[]',?6)",
        params![format!("{turn}-outcome"), session, turn, format!("{turn}-user"), format!("{turn}-assistant"), at],
    )
    .unwrap();
    published(db);
    turn
}

/// Moves the public source revision, as the store's own writers do.
pub(super) fn published(db: &Connection) {
    db.execute(
        "UPDATE conversation_public_source_state SET revision=revision+1 WHERE singleton=1",
        [],
    )
    .unwrap();
}

/// A recovered standalone user message (imported history).
pub(super) fn recovered(db: &Connection, session: &str, seq: u64, text: &str, at: &str) {
    let message = format!("{session}-recovered-{seq}");
    db.execute(
        "INSERT INTO conversation_messages(id,session_id,turn_id,seq,role,status,visibility,provenance,created_at,origin_kind) \
         VALUES(?1,?2,NULL,?3,'user','complete','user','imported',?4,'user_input')",
        params![message, session, seq, at],
    )
    .unwrap();
    db.execute(
        "INSERT INTO conversation_parts(id,message_id,part_index,kind,content_json,status) \
         VALUES(?1,?2,0,'text',?3,'complete')",
        params![
            format!("{message}-part"),
            message,
            json!({"text": text}).to_string()
        ],
    )
    .unwrap();
    published(db);
}

/// Regenerates turn `n` of `session`: a new public answer and the next
/// outcome generation naming it, as a retried turn is stored.
pub(super) fn regenerate(db: &Connection, session: &str, n: u64, text: &str, at: &str) {
    let turn = format!("{session}-turn-{n}");
    let answer = format!("{turn}-assistant-2");
    db.execute(
        "INSERT INTO conversation_messages(id,session_id,turn_id,seq,role,status,visibility,provenance,created_at,origin_kind) \
         VALUES(?1,?2,?3,?4,'assistant','complete','user','trusted',?5,'assistant_public')",
        params![answer, session, turn, 1_000 + n, at],
    )
    .unwrap();
    db.execute(
        "INSERT INTO conversation_parts(id,message_id,part_index,kind,content_json,status) \
         VALUES(?1,?2,0,'text',?3,'complete')",
        params![
            format!("{answer}-part"),
            answer,
            json!({"text": text}).to_string()
        ],
    )
    .unwrap();
    db.execute(
        "UPDATE conversation_turn_outcomes SET generation=generation+1,public_assistant_message_id=?1 WHERE turn_id=?2",
        params![answer, turn],
    )
    .unwrap();
    published(db);
}

/// A delivered turn whose request part is not valid JSON.
pub(super) fn unreadable_turn(db: &Connection, session: &str, n: u64, at: &str) {
    let turn = turn(db, session, n, "unreadable request", at);
    db.execute(
        "UPDATE conversation_parts SET content_json='{not json' WHERE message_id=?1",
        [format!("{turn}-user")],
    )
    .unwrap();
}

/// A consistent copy of the canonical store at `target`.
pub(super) fn back_up(db: &Connection, target: &Path) {
    db.execute_batch(&format!("VACUUM INTO '{}'", target.display()))
        .unwrap();
}

/// Replaces the canonical store at `store` with the copy at `backup`, as
/// restoring a backup while the agent is stopped does.
pub(super) fn restore(backup: &Path, store: &Path) {
    for suffix in ["-wal", "-shm"] {
        let side = store.with_file_name(format!(
            "{}{suffix}",
            store.file_name().unwrap().to_string_lossy()
        ));
        if side.exists() {
            std::fs::remove_file(side).unwrap();
        }
    }
    std::fs::copy(backup, store).unwrap();
    drop(sqlite::open(store).unwrap());
}

/// Logs about `changes` source changes on turn `turn` of `session` through
/// the store's own triggers: tool messages added to the turn, then their
/// status flipped back and forth.
pub(super) fn churn(db: &Connection, session: &str, turn: &str, changes: usize) {
    const MESSAGES: usize = 1_000;
    db.execute_batch("BEGIN").unwrap();
    for index in 0..MESSAGES {
        db.execute(
            "INSERT INTO conversation_messages(id,session_id,turn_id,seq,role,status,visibility,provenance,created_at,origin_kind) \
             VALUES(?1,?2,?3,?4,'tool','complete','model','trusted','2026-02-10T00:00:00.000Z','internal_control')",
            params![format!("{turn}-tool-{index}"), session, turn, 50_000 + index],
        )
        .unwrap();
    }
    for _ in 0..changes.div_ceil(MESSAGES) {
        db.execute(
            "UPDATE conversation_messages SET status=CASE status WHEN 'complete' THEN 'failed' ELSE 'complete' END \
             WHERE turn_id=?1 AND role='tool'",
            [turn],
        )
        .unwrap();
    }
    db.execute_batch("COMMIT").unwrap();
}
