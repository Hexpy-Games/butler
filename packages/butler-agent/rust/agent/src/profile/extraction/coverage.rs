use parking_lot::Mutex;
use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

use rusqlite::{OptionalExtension, Transaction, params};

use super::super::contracts::{ProfileHostFacts, ProfileResult};
use super::super::storage;
use super::types::{CoverageCounts, EXTRACTOR_VERSION, SourceRead, SourceWindow};
use crate::coordination::CognitionProcessStatus;

pub(super) fn persist_discovery(root: &Path, read: &SourceRead, now: &str) -> ProfileResult<()> {
    let mut db = storage::open(root, true)?;
    let tx = db.transaction().map_err(storage::db_error)?;
    if !read.stale_keys.is_empty() {
        let mut mark = tx.prepare("UPDATE profile_source_coverage SET failure_code='source_stale',updated_at=?1 WHERE coverage_key=?2 AND owner_nonce IS NULL").map_err(storage::db_error)?;
        for key in &read.stale_keys {
            mark.execute(params![now, key]).map_err(storage::db_error)?;
        }
    }
    if let Some(offset) = read.persistent_offset {
        tx.execute("INSERT INTO profile_meta(key,value_json,updated_at)VALUES('source_scan_offset',?1,?2) ON CONFLICT(key)DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at", params![offset.to_string(), now]).map_err(storage::db_error)?;
    }
    register(&tx, &read.windows, now)?;
    tx.commit().map_err(storage::db_error)
}

pub(super) fn register(
    db: &Transaction<'_>,
    windows: &[SourceWindow],
    now: &str,
) -> ProfileResult<()> {
    let mut write = db.prepare("INSERT INTO profile_source_coverage(coverage_key,message_id,source_hash,part_id,part_index,scalar_pointer,byte_start,byte_end,extractor_version,observed_at,evidence_ref,disposition,failure_code,usage_json,updated_at)VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'pending',NULL,NULL,?12)ON CONFLICT(coverage_key)DO NOTHING").map_err(storage::db_error)?;
    for window in windows {
        write
            .execute(params![
                window.coverage_key,
                window.message_id,
                window.source_hash,
                window.part_id,
                window.part_index,
                window.scalar_pointer,
                window.byte_start as i64,
                window.byte_end as i64,
                EXTRACTOR_VERSION,
                window.timestamp,
                window.evidence_ref,
                now
            ])
            .map_err(storage::db_error)?;
    }
    Ok(())
}

pub(super) fn claim(
    root: &Path,
    windows: &[SourceWindow],
    host: &dyn ProfileHostFacts,
    active: &Arc<Mutex<HashSet<String>>>,
) -> ProfileResult<Option<String>> {
    let nonce = host.new_uuid();
    let pid = f64::from(host.process_id());
    let mut added = Vec::new();
    let result = (|| {
        let mut db = storage::open(root, true)?;
        let tx = db.transaction().map_err(storage::db_error)?;
        for window in windows {
            let row = tx.query_row("SELECT disposition,owner_pid,owner_nonce FROM profile_source_coverage WHERE coverage_key=?1", [&window.coverage_key], |row| Ok((row.get::<_,String>(0)?,row.get::<_,Option<f64>>(1)?,row.get::<_,Option<String>>(2)?))).optional().map_err(storage::db_error)?;
            let Some((disposition, owner_pid, owner_nonce)) = row else {
                return Ok(None);
            };
            if disposition == "complete" {
                return Ok(None);
            }
            if let (Some(owner_pid), Some(owner_nonce)) = (owner_pid, owner_nonce)
                && owner_live(
                    root,
                    &window.coverage_key,
                    owner_pid,
                    &owner_nonce,
                    host,
                    active,
                )
            {
                return Ok(None);
            }
        }
        let now = host.now_iso();
        let mut update = tx.prepare("UPDATE profile_source_coverage SET owner_pid=?1,owner_nonce=?2,claimed_at=?3,updated_at=?3 WHERE coverage_key=?4 AND disposition IN ('pending','failed')").map_err(storage::db_error)?;
        for window in windows {
            update
                .execute(params![pid, nonce, now, window.coverage_key])
                .map_err(storage::db_error)?;
        }
        drop(update);
        tx.commit().map_err(storage::db_error)?;
        let mut registry = active.lock();
        for window in windows {
            let key = operation_key(root, &window.coverage_key, &nonce);
            registry.insert(key.clone());
            added.push(key);
        }
        Ok(Some(nonce.clone()))
    })();
    if result.is_err() {
        let mut registry = active.lock();
        for key in added {
            registry.remove(&key);
        }
    }
    result
}

pub(super) fn release(
    root: &Path,
    windows: &[SourceWindow],
    nonce: &str,
    host: &dyn ProfileHostFacts,
    active: &Arc<Mutex<HashSet<String>>>,
) -> ProfileResult<()> {
    let result = (|| {
        let mut db = storage::open(root, true)?;
        let tx = db.transaction().map_err(storage::db_error)?;
        let now = host.now_iso();
        let mut statement = tx.prepare("UPDATE profile_source_coverage SET owner_pid=NULL,owner_nonce=NULL,claimed_at=NULL,updated_at=?1 WHERE coverage_key=?2 AND owner_pid=?3 AND owner_nonce=?4 AND disposition!='complete'").map_err(storage::db_error)?;
        for window in windows {
            statement
                .execute(params![
                    now,
                    window.coverage_key,
                    f64::from(host.process_id()),
                    nonce
                ])
                .map_err(storage::db_error)?;
        }
        drop(statement);
        tx.commit().map_err(storage::db_error)
    })();
    let mut registry = active.lock();
    for window in windows {
        registry.remove(&operation_key(root, &window.coverage_key, nonce));
    }
    result
}

pub(super) fn mark_failed(
    root: &Path,
    windows: &[SourceWindow],
    failure: &str,
    usage_json: &str,
    nonce: &str,
    host: &dyn ProfileHostFacts,
) -> ProfileResult<()> {
    let mut db = storage::open(root, true)?;
    let tx = db.transaction().map_err(storage::db_error)?;
    let now = host.now_iso();
    let failure = super::super::naming::bounded(failure, 120);
    let mut statement = tx.prepare("UPDATE profile_source_coverage SET disposition='failed',failure_code=?1,usage_json=?2,owner_pid=NULL,owner_nonce=NULL,claimed_at=NULL,updated_at=?3 WHERE coverage_key=?4 AND owner_pid=?5 AND owner_nonce=?6").map_err(storage::db_error)?;
    for window in windows {
        statement
            .execute(params![
                failure,
                usage_json,
                now,
                window.coverage_key,
                f64::from(host.process_id()),
                nonce
            ])
            .map_err(storage::db_error)?;
    }
    drop(statement);
    tx.commit().map_err(storage::db_error)
}

pub(super) fn mark_failed_unclaimed(
    root: &Path,
    window: &SourceWindow,
    failure: &str,
    host: &dyn ProfileHostFacts,
) -> ProfileResult<()> {
    let db = storage::open(root, true)?;
    db.execute("UPDATE profile_source_coverage SET disposition='failed',failure_code=?1,usage_json='null',updated_at=?2 WHERE coverage_key=?3",params![super::super::naming::bounded(failure,120),host.now_iso(),window.coverage_key]).map_err(storage::db_error)?;
    Ok(())
}

pub(super) fn forget(
    root: &Path,
    windows: &[SourceWindow],
    nonce: &str,
    active: &Arc<Mutex<HashSet<String>>>,
) {
    let mut registry = active.lock();
    for window in windows {
        registry.remove(&operation_key(root, &window.coverage_key, nonce));
    }
}

pub(super) fn counts(root: &Path, keys: &HashSet<String>) -> ProfileResult<CoverageCounts> {
    if keys.is_empty() || !storage::database_path(root).exists() {
        return Ok(CoverageCounts::default());
    }
    let db = storage::open(root, false)?;
    let mut output = CoverageCounts::default();
    let mut statement = db
        .prepare("SELECT disposition FROM profile_source_coverage WHERE coverage_key=?1")
        .map_err(storage::db_error)?;
    for key in keys {
        let disposition = statement
            .query_row([key], |row| row.get::<_, String>(0))
            .optional()
            .map_err(storage::db_error)?;
        match disposition.as_deref() {
            Some("pending") => output.pending += 1,
            Some("failed") => output.failed += 1,
            Some("complete") => output.complete += 1,
            _ => {}
        }
    }
    Ok(output)
}

pub(super) fn replace_parent(
    root: &Path,
    parent: &SourceWindow,
    children: &[SourceWindow],
    host: &dyn ProfileHostFacts,
    active: &Arc<Mutex<HashSet<String>>>,
) -> ProfileResult<bool> {
    let mut db = storage::open(root, true)?;
    let tx = db.transaction().map_err(storage::db_error)?;
    let row = tx.query_row("SELECT message_id,source_hash,part_id,scalar_pointer,byte_start,byte_end,extractor_version,disposition,owner_pid,owner_nonce FROM profile_source_coverage WHERE coverage_key=?1", [&parent.coverage_key], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,i64>(4)?,row.get::<_,i64>(5)?,row.get::<_,String>(6)?,row.get::<_,String>(7)?,row.get::<_,Option<f64>>(8)?,row.get::<_,Option<String>>(9)?))).optional().map_err(storage::db_error)?;
    let Some((message, hash, part, pointer, start, end, version, disposition, pid, nonce)) = row
    else {
        return Ok(false);
    };
    if !matches!(disposition.as_str(), "pending" | "failed")
        || message != parent.message_id
        || hash != parent.source_hash
        || part != parent.part_id
        || pointer != parent.scalar_pointer
        || start != parent.byte_start as i64
        || end != parent.byte_end as i64
        || version != EXTRACTOR_VERSION
    {
        return Ok(false);
    }
    if let (Some(pid), Some(nonce)) = (pid, nonce.as_deref())
        && owner_live(root, &parent.coverage_key, pid, nonce, host, active)
    {
        return Ok(false);
    }
    let removed=tx.execute("DELETE FROM profile_source_coverage WHERE coverage_key=?1 AND message_id=?2 AND source_hash=?3 AND part_id=?4 AND scalar_pointer=?5 AND byte_start=?6 AND byte_end=?7 AND extractor_version=?8 AND disposition IN ('pending','failed') AND COALESCE(owner_pid,-1)=COALESCE(?9,-1) AND COALESCE(owner_nonce,'')=COALESCE(?10,'')",params![parent.coverage_key,parent.message_id,parent.source_hash,parent.part_id,parent.scalar_pointer,parent.byte_start as i64,parent.byte_end as i64,EXTRACTOR_VERSION,pid,nonce]).map_err(storage::db_error)?;
    if removed != 1 {
        return Ok(false);
    }
    register(&tx, children, &host.now_iso())?;
    tx.commit().map_err(storage::db_error)?;
    Ok(true)
}

fn owner_live(
    root: &Path,
    key: &str,
    pid: f64,
    nonce: &str,
    host: &dyn ProfileHostFacts,
    active: &Arc<Mutex<HashSet<String>>>,
) -> bool {
    if pid == f64::from(host.process_id()) {
        return active.lock().contains(&operation_key(root, key, nonce));
    }
    host.process_status(pid) != CognitionProcessStatus::DefinitelyDead
}

fn operation_key(root: &Path, key: &str, nonce: &str) -> String {
    serde_json::Value::from([root.to_string_lossy().as_ref(), key, nonce].as_slice()).to_string()
}

#[cfg(test)]
mod tests;
