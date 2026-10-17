//! Atomic terminal ownership: a terminal Work cannot retain open delegated work.
use super::{StorageError, StorageResult};
use rusqlite::{Connection, params};

// Start with only live Works, then resolve delegation and parent by indexed keys.
pub(super) const ORPHANS: &str = "SELECT DISTINCT p.work_id FROM btcc_guided_works c INDEXED BY idx_btcc_work_open CROSS JOIN btcc_subsession_delegations d ON d.root_work_id=c.work_id CROSS JOIN btcc_guided_works p ON p.work_id=json_extract(d.packet_json,'$.parent_work_ref.work_id') WHERE c.status IN ('open','blocked') AND p.status IN ('completed','abandoned')";

pub(in crate::btcc::storage) fn repair(db: &mut Connection) -> StorageResult<()> {
    let parents = db
        .prepare_cached(ORPHANS)
        .map_err(StorageError::sqlite)?
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(StorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::sqlite)?;
    for parent in parents {
        let tx = db.transaction().map_err(StorageError::sqlite)?;
        let now = chrono::Utc::now().to_rfc3339();
        close_children(&tx, &parent, &now)?;
        tx.commit().map_err(StorageError::sqlite)?;
    }
    Ok(())
}

/// The caller owns the transaction, including the parent's terminal transition.
pub(in crate::btcc::storage) fn close_children(
    db: &Connection,
    parent: &str,
    now: &str,
) -> StorageResult<()> {
    let mut pending = vec![parent.to_owned()];
    let mut seen = std::collections::HashSet::new();
    while let Some(parent) = pending.pop() {
        if !seen.insert(parent.clone()) {
            continue;
        }
        for child in delegated_children(db, &parent)? {
            if child.open {
                close_relation(
                    db,
                    &child.session,
                    &child.relation,
                    &child.task,
                    &child.turn,
                    now,
                )?;
                db.execute("UPDATE btcc_guided_works SET status='abandoned',updated_at=?2 WHERE work_id=?1 AND status IN ('open','blocked')",params![child.work,now]).map_err(StorageError::sqlite)?;
                super::super::authority::close_pending_source_work_requests(db, &child.work, now)?;
            }
            pending.push(child.work);
        }
    }
    Ok(())
}

struct DelegatedWork {
    work: String,
    session: String,
    relation: String,
    task: String,
    turn: String,
    open: bool,
}

fn delegated_children(db: &Connection, parent: &str) -> StorageResult<Vec<DelegatedWork>> {
    db.prepare_cached("SELECT c.work_id,c.session_id,d.relation_id,d.task_id,d.child_turn_id,c.status IN ('open','blocked') FROM btcc_subsession_delegations d JOIN btcc_guided_works c ON c.work_id=d.root_work_id WHERE json_extract(d.packet_json,'$.parent_work_ref.work_id')=+?1")
        .map_err(StorageError::sqlite)?
        .query_map([parent], |r| Ok(DelegatedWork { work:r.get(0)?, session:r.get(1)?, relation:r.get(2)?, task:r.get(3)?, turn:r.get(4)?, open:r.get(5)? }))
        .map_err(StorageError::sqlite)?.collect::<Result<Vec<_>,_>>().map_err(StorageError::sqlite)
}

fn close_relation(
    db: &Connection,
    session: &str,
    relation: &str,
    task: &str,
    initial_turn: &str,
    now: &str,
) -> StorageResult<()> {
    let turns = db
        .prepare_cached(
            "SELECT turn_id FROM btcc_turns WHERE session_id=?1 AND semantic_state='admitted'",
        )
        .map_err(StorageError::sqlite)?
        .query_map([session], |r| r.get::<_, String>(0))
        .map_err(StorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::sqlite)?;
    for turn in turns.iter().map(String::as_str).chain([initial_turn]) {
        let id = super::super::subsessions::completion::turn_result_id(session, turn);
        db.execute("INSERT OR IGNORE INTO btcc_steward_results (result_id,relation_id,task_id,child_session_id,child_turn_id,status,code,summary,acceptance_evidence_json,changed_artifacts_json,created_at) VALUES (?1,?2,?3,?4,?5,'cancelled','steward_cancelled','Parent Work ended','[]','[]',?6)",params![id,relation,task,session,turn,now]).map_err(StorageError::sqlite)?;
    }
    for turn in turns {
        db.execute("UPDATE btcc_turns SET semantic_state='cancelled',active_checkpoint_id=NULL,authority_continuation_json=CASE WHEN suspension_reason='authority_pending' THEN authority_continuation_json ELSE NULL END,suspension_reason=NULL,revision=revision+1,execution_fence=execution_fence+1,final_disposition='cancelled' WHERE turn_id=?1 AND semantic_state='admitted'",[&turn]).map_err(StorageError::sqlite)?;
        db.execute("UPDATE btcc_checkpoints SET is_active=0,active_claim_id=NULL WHERE turn_id=?1 AND is_active=1",[&turn]).map_err(StorageError::sqlite)?;
        db.execute(
            "UPDATE btcc_state_claims SET status='revoked' WHERE turn_id=?1 AND status='active'",
            [turn],
        )
        .map_err(StorageError::sqlite)?;
    }
    db.execute("UPDATE btcc_subsession_delegations SET dispatch_state=NULL WHERE relation_id=?1 AND dispatch_state IS NOT NULL",[relation]).map_err(StorageError::sqlite)?;
    super::super::authority::close_pending_self_session_requests(
        db,
        session,
        "session_cancelled",
        now,
    )?;
    Ok(())
}

pub(in crate::btcc::storage) async fn startup(
    path: std::path::PathBuf,
    profile: super::super::StorageProfile,
) -> StorageResult<()> {
    tokio::task::spawn_blocking(move || {
        let mut db = butler_platform::sqlite::open(&path).map_err(StorageError::sqlite)?;
        super::super::configure(&db, profile)?;
        repair(&mut db)
    })
    .await
    .map_err(|error| {
        StorageError::new(
            crate::btcc::StorageCode::SqliteOperationCompletionLost,
            error.to_string(),
        )
    })?
}
