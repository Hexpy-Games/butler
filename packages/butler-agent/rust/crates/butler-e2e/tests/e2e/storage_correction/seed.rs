//! Synthetic legacy payloads and exact offline snapshots; no owner data.
use butler_e2e::e2e::HarnessError;
use rusqlite::{Connection, params, types::ValueRef};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path};

pub(super) struct Profile {
    pub turns: usize,
    pub rows: usize,
    pub live_bytes: usize,
}
impl Profile {
    pub(super) fn small() -> Self {
        Self {
            turns: 120,
            rows: 480,
            live_bytes: 40_000_000,
        }
    }
}

pub(super) fn seed(path: &Path, p: &Profile) -> Result<(), HarnessError> {
    let mut db = Connection::open(path)?;
    db.execute_batch(
        "PRAGMA secure_delete=OFF; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;",
    )?;
    // Exercise the additive migration against the actual pre-upgrade layout.
    db.execute_batch("ALTER TABLE btcc_model_round_acceptances DROP COLUMN continuation_delta_json; ALTER TABLE btcc_model_round_acceptances DROP COLUMN payload_state;")?;
    let tx = db.transaction()?;
    for i in 0..p.turns {
        let id = format!("corr-{i:04}");
        tx.execute("INSERT INTO btcc_inbound_inbox(inbox_id,session_id,trigger_key,turn_id,admission_input_hash,command_json,status) VALUES(?1,?2,?1,?1,'fixture','{}','constructed')",params![id,format!("corr-chat-{i}")])?;
        tx.execute("INSERT INTO btcc_turns(turn_id,session_id,inbox_id,trigger_key,original_message_id,original_message,admission_snapshot_ref,model_selection_json,context_json,semantic_state,revision,execution_fence) VALUES(?1,?3,?1,?1,?1,'Synthetic history','fixture','{}','{}',?2,1,1)",params![id,if i%20==0 {"cancelled"} else {"delivered"},format!("corr-chat-{i}")])?;
        tx.execute("INSERT INTO btcc_messages(message_id,session_id,turn_id,role,content,idempotency_key,created_at) VALUES(?1,?2,?1,'assistant','Synthetic history',?1,'2026-01-01T00:00:00Z')",params![id,format!("corr-chat-{i}")])?;
    }
    let mut insert=tx.prepare("INSERT INTO btcc_model_round_acceptances(acceptance_id,turn_id,round_id,route_digest,candidate_index,checkpoint_id,checkpoint_revision,model_ref,transport_attempt,normalized_response_json,provider_identity_json,created_at) VALUES(?1,?2,?1,'fixture',0,'fixture',1,'openai/gpt-6-luna',1,?3,'{}','2026-01-01T00:00:00Z')")?;
    let mut ordered = Vec::with_capacity(p.rows);
    for i in 0..p.rows {
        let turn = format!("corr-{:04}", i % p.turns);
        ordered.push((turn, i));
    }
    // Legacy rounds append together within a turn; preserve that physical
    // layout rather than artificially interleaving every historical session.
    ordered.sort();
    for (turn, i) in ordered {
        let bytes = 600_000;
        let payload = format!(
            r#"{{"continuation":{{"statelessInput":[{{"type":"message","content":"distinct-{i}:{}"}}]}}}}"#,
            "x".repeat(bytes)
        );
        insert.execute(params![format!("corr-row-{i:05}"), turn, payload])?;
    }
    drop(insert);
    for i in 0..p.live_bytes.div_ceil(1_000_000) {
        tx.execute("INSERT INTO btcc_records(record_id,kind,sha256,content_json) VALUES(?1,'fixture','fixture',?2)",params![format!("corr-live-{i}"),format!("\"{}\"","z".repeat(1_000_000))])?;
    }
    tx.commit()?;
    db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); DROP TRIGGER acceptance_reclaim_on_settle; DROP TABLE agent_storage_corrections; DROP TABLE agent_acceptance_reclaims;")?;
    db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
    seed_history(path, p.turns)?;
    Ok(())
}

pub(super) fn snapshot(path: &Path) -> Result<BTreeMap<String, (u64, String)>, HarnessError> {
    let db = Connection::open(path)?;
    let tables=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT IN ('agent_storage_corrections','agent_acceptance_reclaims') ORDER BY name")?.query_map([],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    assert_process_lifecycle(&db)?;
    let mut out = BTreeMap::new();
    for table in tables {
        // Boot/clean events vary across restart independently of correction.
        // Their exact relationship to the process marker is asserted above.
        let sql = if table == "wm_runtime_marker" {
            "SELECT singleton FROM wm_runtime_marker".to_owned()
        } else if table == "wm_audit" {
            "SELECT * FROM wm_audit WHERE entity_kind<>'runtime_marker' ORDER BY seq".to_owned()
        } else if table == "sqlite_sequence" {
            "SELECT * FROM sqlite_sequence WHERE name<>'wm_audit' ORDER BY name".to_owned()
        } else if table == "btcc_model_round_acceptances" {
            "SELECT acceptance_id,turn_id,round_id,route_digest,candidate_index,checkpoint_id,checkpoint_revision,model_ref,transport_attempt,provider_identity_json,created_at FROM btcc_model_round_acceptances ORDER BY rowid".to_owned()
        } else {
            format!(
                "SELECT * FROM \"{}\" ORDER BY rowid",
                table.replace('"', "\"\"")
            )
        };
        let mut query = db
            .prepare(&sql)
            .or_else(|_| db.prepare(&sql.replace("ORDER BY rowid", "ORDER BY 1")))?;
        let columns = query.column_count();
        let mut rows = query.query([])?;
        let mut hash = Sha256::new();
        let mut count = 0;
        while let Some(row) = rows.next()? {
            for col in 0..columns {
                let bytes = match row.get_ref(col)? {
                    ValueRef::Null => b"null".to_vec(),
                    ValueRef::Integer(v) => v.to_le_bytes().to_vec(),
                    ValueRef::Real(v) => v.to_le_bytes().to_vec(),
                    ValueRef::Text(v) | ValueRef::Blob(v) => v.to_vec(),
                };
                hash.update((bytes.len() as u64).to_le_bytes());
                hash.update(bytes);
            }
            count += 1;
        }
        out.insert(table, (count, format!("{:x}", hash.finalize())));
    }
    snapshot_lifecycle(&db, &mut out)?;
    Ok(out)
}

pub(super) fn admitted(path: &Path, turn: &str) -> Result<Vec<String>, HarnessError> {
    let db = Connection::open(path)?;
    Ok(db.prepare("SELECT normalized_response_json FROM btcc_model_round_acceptances WHERE turn_id=?1 ORDER BY rowid")?.query_map([turn],|r|r.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub(super) fn assert_correct(
    path: &Path,
    settled: usize,
    active: &str,
    before: &[String],
) -> Result<(), HarnessError> {
    let db = Connection::open(path)?;
    assert_eq!(admitted(path, active)?, before);
    let reclaimed:usize=db.query_row("SELECT count(*) FROM btcc_model_round_acceptances WHERE acceptance_id LIKE 'corr-row-%' AND turn_id<>?1 AND payload_state=2 AND normalized_response_json='{}' AND continuation_delta_json IS NULL",[active],|r|r.get(0))?;
    assert_eq!(reclaimed, settled);
    let state: String = db.query_row(
        "SELECT state FROM agent_storage_corrections WHERE name='acceptance_payload_v1'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(state, "done");
    let integrity: String = db.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    assert_eq!(integrity, "ok");
    let secure: i64 = db.pragma_query_value(None, "secure_delete", |r| r.get(0))?;
    assert_eq!(secure, 0);
    assert!(!path.with_extension("sqlite.compact-tmp").exists());
    assert!(!path.with_extension("sqlite.precompact").exists());
    Ok(())
}

/// Matching public history for every seeded BTCC session.
fn seed_history(path: &Path, turns: usize) -> Result<(), HarnessError> {
    let data = path
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| butler_e2e::e2e::harness_error("missing synthetic data root"))?;
    let mut db = Connection::open(data.join("app-server/butler-client.sqlite"))?;
    let tx = db.transaction()?;
    for i in 0..turns {
        let id = format!("corr-chat-{i}");
        let turn = format!("corr-{i:04}");
        tx.execute("INSERT INTO chats(id,title,kind,created_at,updated_at) VALUES(?1,'Synthetic history','chat','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",[&id])?;
        tx.execute("INSERT INTO turns(id,chat_id,state,safe_status_label,created_at,updated_at) VALUES(?1,?2,'delivered','Delivered','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",params![turn,id])?;
        tx.execute("INSERT INTO messages(id,chat_id,turn_id,role,text,status,created_at,updated_at) VALUES(?1,?2,?1,'assistant','Synthetic history','delivered','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",params![turn,id])?;
    }
    tx.commit()?;
    Ok(())
}

pub(super) fn live_bytes(path: &Path) -> Result<u64, HarnessError> {
    let db = Connection::open(path)?;
    let size: u64 = db.pragma_query_value(None, "page_size", |r| r.get(0))?;
    let count: u64 = db.pragma_query_value(None, "page_count", |r| r.get(0))?;
    let free: u64 = db.pragma_query_value(None, "freelist_count", |r| r.get(0))?;
    Ok((count - free) * size)
}

/// Only the process lifecycle may vary while correction preserves domain rows.
fn assert_process_lifecycle(db: &Connection) -> Result<(), HarnessError> {
    use rusqlite::OptionalExtension;
    let marker = db
        .query_row(
            "SELECT boot_id,started_at,clean_shutdown_at FROM wm_runtime_marker WHERE singleton=1",
            [],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, Option<i64>>(2)?,
                ))
            },
        )
        .optional()?;
    if let Some((boot, started, clean)) = marker {
        assert!(uuid::Uuid::parse_str(&boot).is_ok());
        let events = db.prepare("SELECT op,at FROM wm_audit WHERE entity_kind='runtime_marker' AND entity_id=?1 ORDER BY seq")?
            .query_map([boot], |r| Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut expected = vec![("begin_boot".into(), started)];
        if let Some(clean) = clean {
            assert!(clean >= started);
            expected.push(("clean_shutdown".into(), clean));
        }
        assert_eq!(events, expected);
        let sequence: i64 = db.query_row(
            "SELECT seq FROM sqlite_sequence WHERE name='wm_audit'",
            [],
            |r| r.get(0),
        )?;
        let maximum: i64 = db.query_row("SELECT coalesce(max(seq),0) FROM wm_audit", [], |r| {
            r.get(0)
        })?;
        assert_eq!(sequence, maximum);
    }
    Ok(())
}

/// Restart may append lifecycle records, but every earlier record stays exact.
fn snapshot_lifecycle(
    db: &Connection,
    out: &mut BTreeMap<String, (u64, String)>,
) -> Result<(), HarnessError> {
    let mut query =
        db.prepare("SELECT * FROM wm_audit WHERE entity_kind='runtime_marker' ORDER BY seq")?;
    let columns = query.column_count();
    let mut rows = query.query([])?;
    while let Some(row) = rows.next()? {
        let seq: i64 = row.get(0)?;
        let contents = (0..columns)
            .map(|i| row.get_ref(i).map(|v| format!("{v:?}")))
            .collect::<rusqlite::Result<Vec<_>>>()?;
        out.insert(
            format!("wm_audit:{seq}"),
            (
                1,
                format!("{:x}", Sha256::digest(serde_json::to_vec(&contents)?)),
            ),
        );
    }
    Ok(())
}
