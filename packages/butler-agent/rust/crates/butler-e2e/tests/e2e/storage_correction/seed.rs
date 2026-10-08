//! Synthetic legacy payloads and exact offline snapshots; no owner data.
use butler_e2e::e2e::HarnessError;
use rusqlite::{Connection, params, types::ValueRef};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path};

pub(super) struct Profile {
    pub turns: usize,
    pub rows: usize,
    pub live_bytes: usize,
    pub perf: bool,
}
impl Profile {
    pub(super) fn small() -> Self {
        Self {
            turns: 120,
            rows: 480,
            live_bytes: 40_000_000,
            perf: false,
        }
    }
    pub(super) fn owner() -> Self {
        Self {
            turns: 2440,
            rows: 15886,
            live_bytes: 450_000_000,
            perf: true,
        }
    }
}

pub(super) fn seed(path: &Path, p: &Profile, active: &str) -> Result<(), HarnessError> {
    let mut db = Connection::open(path)?;
    db.execute_batch(
        "PRAGMA secure_delete=OFF; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;",
    )?;
    let tx = db.transaction()?;
    for i in 0..p.turns {
        let id = format!("corr-{i:04}");
        tx.execute("INSERT INTO btcc_inbound_inbox(inbox_id,session_id,trigger_key,turn_id,admission_input_hash,command_json,status) VALUES(?1,'general',?1,?1,'fixture','{}','constructed')",[&id])?;
        tx.execute("INSERT INTO btcc_turns(turn_id,session_id,inbox_id,trigger_key,original_message_id,original_message,admission_snapshot_ref,model_selection_json,context_json,semantic_state,revision,execution_fence) VALUES(?1,'general',?1,?1,?1,'Synthetic history','fixture','{}','{}',?2,1,1)",params![id,if i%20==0 {"cancelled"} else {"delivered"}])?;
    }
    let admitted = if p.perf { 162 } else { 0 };
    let mut insert=tx.prepare("INSERT INTO btcc_model_round_acceptances(acceptance_id,turn_id,round_id,route_digest,candidate_index,checkpoint_id,checkpoint_revision,model_ref,transport_attempt,normalized_response_json,provider_identity_json,created_at) VALUES(?1,?2,?1,'fixture',0,'fixture',1,'openai/gpt-6-luna',1,?3,'{}','2026-01-01T00:00:00Z')")?;
    let mut ordered = Vec::with_capacity(p.rows);
    for i in 0..p.rows {
        let turn = if i < admitted {
            active.to_owned()
        } else if p.perf && i < admitted + 473 {
            "corr-0001".to_owned()
        } else {
            {
                let slot = (i - admitted) % if p.perf { p.turns - 1 } else { p.turns };
                format!(
                    "corr-{:04}",
                    if p.perf && slot >= 1 { slot + 1 } else { slot }
                )
            }
        };
        ordered.push((turn, i));
    }
    // Legacy rounds append together within a turn; preserve that physical
    // layout rather than artificially interleaving every historical session.
    ordered.sort();
    for (turn, i) in ordered {
        let bytes = if !p.perf {
            600_000
        } else if i < admitted {
            387_000
        } else if i < admitted + 473 {
            1_020_000 + (i - admitted) * 1_520_000 / 472
        } else {
            344_000 + (i % 7) * 1_000
        };
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
    Ok(())
}

pub(super) fn snapshot(path: &Path) -> Result<BTreeMap<String, (u64, String)>, HarnessError> {
    let db = Connection::open(path)?;
    let tables=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT IN ('agent_storage_corrections','agent_acceptance_reclaims') ORDER BY name")?.query_map([],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut out = BTreeMap::new();
    for table in tables {
        let sql = if table == "btcc_model_round_acceptances" {
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
