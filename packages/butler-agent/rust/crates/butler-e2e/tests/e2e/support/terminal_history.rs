//! Terminal BTCC history must not be visited by idle admission or delivery polls.
const BTCC_PAYLOAD_BYTES: [usize; 7] = [16, 18, 20, 22, 18, 20, 22];
use butler_e2e::e2e::HarnessError;
use rusqlite::{Connection, params};
use std::path::{Path, PathBuf};

pub(super) const TURNS: i64 = 48;
pub(super) const WAITING: &str = "SELECT DISTINCT session_id FROM btcc_turns WHERE semantic_state='admitted' AND suspension_reason='authority_pending'";
pub(super) const OUTBOX: &str = "SELECT result_id,parent_session_id,input_json FROM btcc_subsession_outbox WHERE status='pending' ORDER BY created_at";
const CUTOVER: &str = "SELECT original_message FROM btcc_turns WHERE turn_id IN (SELECT turn_id FROM btcc_turns WHERE semantic_state NOT IN ('admitted','delivery_committed','delivered','cancelled') UNION SELECT turn_id FROM btcc_turns WHERE semantic_state IS NULL UNION SELECT evidence.turn_id FROM btcc_r3_legacy_turn_cutovers evidence WHERE (SELECT semantic_state FROM btcc_turns WHERE turn_id=evidence.turn_id)='admitted') ORDER BY turn_id";

pub(super) fn path(data: &Path) -> PathBuf {
    data.join("agent-runtime/btcc.sqlite")
}

pub(super) fn seed(data: &Path) -> Result<(), HarnessError> {
    let mut db = Connection::open(path(data))?;
    // These are terminal historical rows. No recovery/model work is required.
    let tx = db.transaction()?;
    {
        let mut inbox = tx.prepare("INSERT INTO btcc_inbound_inbox(inbox_id,session_id,trigger_key,turn_id,admission_input_hash,command_json,status) VALUES(?1,'history',?1,?1,'fixture','{}','constructed')")?;
        // Match the current activity identity; settled history must not trigger a migration repair.
        let mut relation = tx.prepare("INSERT INTO btcc_session_relations(relation_id,parent_session_id,parent_turn_id,child_session_id,anchor_message_id,ordinal,safe_title,created_at,activity_role,activity_worker_id,activity_terminal) VALUES(?1,'history',?1,?1,?1,?2,'Historical child','2026-01-01T00:00:00Z','steward','steward-'||?1,1)")?;
        let mut turn = tx.prepare("INSERT INTO btcc_turns(turn_id,session_id,inbox_id,trigger_key,original_message_id,original_message,admission_snapshot_ref,model_selection_json,context_json,semantic_state,revision,execution_fence) VALUES(?1,'history',?1,?1,?1,?2,'fixture','{}','{}','delivered',1,1)")?;
        let mut outbox = tx.prepare("INSERT INTO btcc_subsession_outbox(outbox_id,relation_id,result_id,parent_session_id,parent_turn_id,message_id,input_json,status,created_at) VALUES(?1,?1,?1,'history',?1,?1,'{}','delivered','2026-01-01T00:00:00Z')")?;
        let bodies = BTCC_PAYLOAD_BYTES.map(|bytes| "x".repeat(bytes));
        for (index, body) in (0..TURNS).zip(bodies.iter().cycle()) {
            let id = format!("history-{index:06}");
            inbox.execute([&id])?;
            relation.execute(params![id, index])?;
            turn.execute(params![id, body])?;
            outbox.execute([id])?;
        }
    }
    tx.commit()?;
    db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
    let bytes = std::fs::metadata(path(data))?.len();
    eprintln!("PERF-BTCC database_bytes={bytes}");

    Ok(())
}

pub(super) fn assert_complete(data: &Path) -> Result<(), HarnessError> {
    let db = Connection::open(path(data))?;
    let mapping_cap: i64 = db.query_row(
        "SELECT sqlite_compileoption_used('MAX_MMAP_SIZE=8589934592LL')",
        [],
        |row| row.get(0),
    )?;
    assert_eq!(
        mapping_cap, 1,
        "history validation mapping must not be clamped to 2 GiB"
    );
    let runtime_mapping: i64 = db.pragma_query_value(None, "mmap_size", |row| row.get(0))?;
    assert_eq!(
        runtime_mapping, 0,
        "normal connections retain the bounded pager"
    );
    for (table, key) in [
        ("btcc_turns", "turn_id"),
        ("btcc_subsession_outbox", "outbox_id"),
        ("btcc_inbound_inbox", "inbox_id"),
        ("btcc_session_relations", "relation_id"),
    ] {
        let count: i64 = db.query_row(
            &format!("SELECT COUNT(*) FROM {table} WHERE {key} LIKE 'history-%'"),
            [],
            |row| row.get(0),
        )?;
        assert_eq!(count, TURNS);
    }
    let repairs: i64 = db.query_row(
        "SELECT COUNT(*) FROM btcc_session_relations WHERE activity_worker_id != activity_role||'-'||relation_id OR activity_worker_id IS NULL",
        [], |row| row.get(0),
    )?;
    assert_eq!(
        repairs, 0,
        "settled history must already satisfy the activity identity invariant"
    );
    for (id, index) in [("history-000000", 0), ("history-000047", TURNS - 1)] {
        let index = usize::try_from(index).map_err(|error| HarnessError(error.to_string()))?;
        let body: String = db.query_row(
            "SELECT original_message FROM btcc_turns WHERE turn_id=?1",
            [id],
            |row| row.get(0),
        )?;
        assert_eq!(
            body,
            "x".repeat(BTCC_PAYLOAD_BYTES[index % BTCC_PAYLOAD_BYTES.len()])
        );
    }
    Ok(())
}

pub(super) fn assert_indexed(data: &Path) -> Result<(), HarnessError> {
    let db = Connection::open(path(data))?;
    for (query, index) in [
        (WAITING, "idx_btcc_turns_authority_waiting"),
        (OUTBOX, "idx_btcc_subsession_outbox_pending"),
        (CUTOVER, "idx_btcc_turn_cutover_candidates"),
    ] {
        let plan = db
            .prepare(&format!("EXPLAIN QUERY PLAN {query}"))?
            .query_map([], |row| row.get::<_, String>(3))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        assert!(
            plan.iter().any(|line| line.contains(index)),
            "{query}: {plan:?}"
        );
        let rows = db.prepare(query)?.query_map([], |_| Ok(()))?.count();
        assert_eq!(rows, 0, "terminal history appeared as pending work");
    }
    for (column, index) in [
        ("active_checkpoint_id", "idx_btcc_turn_checkpoint_reference"),
        ("delivery_outbox_id", "idx_btcc_turn_outbox_reference"),
        (
            "canonical_assistant_message_id",
            "idx_btcc_turn_message_reference",
        ),
    ] {
        let plan = db
            .prepare(&format!(
                "EXPLAIN QUERY PLAN SELECT {column} FROM btcc_turns WHERE {column} IS NOT NULL"
            ))?
            .query_map([], |row| row.get::<_, String>(3))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        assert!(
            plan.iter().any(|line| line.contains(index)),
            "{column}: {plan:?}"
        );
    }
    Ok(())
}
