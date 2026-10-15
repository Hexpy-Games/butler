//! Adapted from #1048's support/btcc_scale.rs: 23 KB messages keep turns wide.
use super::*;
use rusqlite::params;

pub(super) fn seed(data: &Path) -> Result<(), HarnessError> {
    let app = Connection::open(data.join("app-server/butler-client.sqlite"))?;
    app.execute_batch("WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<799)
      INSERT INTO chats(id,title,kind,pinned,archived,created_at,updated_at)
      SELECT 'history-chat-'||i,'History '||i,'chat',0,0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z' FROM n;
      PRAGMA wal_checkpoint(TRUNCATE)")?;
    assert_eq!(
        app.query_row(
            "SELECT count(*) FROM chats WHERE id LIKE 'history-chat-%'",
            [],
            |r| r.get::<_, u64>(0)
        )?,
        800
    );
    let mut db = Connection::open(data.join("agent-runtime/btcc.sqlite"))?;
    let tx = db.transaction()?;
    {
        let mut inbox = tx.prepare("INSERT INTO btcc_inbound_inbox(inbox_id,session_id,trigger_key,turn_id,admission_input_hash,command_json,status) VALUES(?1,?2,?1,?1,'fixture','{}','constructed')")?;
        let mut turn = tx.prepare("INSERT INTO btcc_turns(turn_id,session_id,inbox_id,trigger_key,original_message_id,original_message,admission_snapshot_ref,model_selection_json,context_json,semantic_state,revision,execution_fence) VALUES(?1,?2,?1,?1,?1,?3,'fixture','{}','{}',?4,1,1)")?;
        let body = "x".repeat(23_000);
        for i in 0..300_000 {
            let id = format!("history-{i:06}");
            let chat = format!("history-chat-{}", i % 800);
            inbox.execute(params![id, chat])?;
            turn.execute(params![
                id,
                chat,
                body,
                if i == 299_999 {
                    "admitted"
                } else {
                    "delivered"
                }
            ])?;
        }
        for i in [0, 150_000, 299_998, 299_999] {
            let id = format!("history-{i:06}");
            // Two rounds per turn prove the entire payload set is reclaimed.
            for round in 0..2 {
                tx.execute("INSERT INTO btcc_model_round_acceptances(acceptance_id,turn_id,round_id,route_digest,candidate_index,checkpoint_id,checkpoint_revision,model_ref,transport_attempt,normalized_response_json,continuation_delta_json,payload_state,created_at) VALUES(?1,?2,?1,'fixture',0,'fixture',1,'openai/gpt-6-luna',1,?3,?3,0,'2026-01-01T00:00:00Z')", params![format!("{id}-{round}"), id, format!("{{\"text\":\"payload-{round}\"}}")])?;
            }
        }
    }
    tx.commit()?;
    // No correction marker represents the first adoption of payload reclamation.
    db.execute_batch("DELETE FROM agent_storage_corrections; DELETE FROM agent_acceptance_reclaims; PRAGMA wal_checkpoint(TRUNCATE)")?;
    eprintln!(
        "RECLAIM-SCALE turns=300000 chats=800 bytes={}",
        std::fs::metadata(data.join("agent-runtime/btcc.sqlite"))?.len()
    );
    Ok(())
}

pub(super) fn assert_complete(path: &Path) -> Result<(), HarnessError> {
    let db = Connection::open(path)?;
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM btcc_turns WHERE turn_id LIKE 'history-%'",
            [],
            |r| r.get::<_, u64>(0)
        )?,
        300_000
    );
    assert_eq!(
        db.query_row(
            "SELECT count(DISTINCT session_id) FROM btcc_turns WHERE turn_id LIKE 'history-%'",
            [],
            |r| r.get::<_, u64>(0)
        )?,
        800
    );
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM btcc_model_round_acceptances WHERE turn_id LIKE 'history-%'",
            [],
            |r| r.get::<_, u64>(0)
        )?,
        8
    );
    let bad: u64 = db.query_row("SELECT count(*) FROM btcc_model_round_acceptances a JOIN btcc_turns t ON t.turn_id=a.turn_id WHERE t.semantic_state<>'admitted' AND (a.payload_state<>2 OR a.normalized_response_json<>'{}' OR a.continuation_delta_json IS NOT NULL)", [], |r| r.get(0))?;
    assert_eq!(bad, 0, "every settled acceptance must be reclaimed");
    let active = db.prepare("SELECT payload_state,normalized_response_json,continuation_delta_json FROM btcc_model_round_acceptances WHERE turn_id='history-299999' ORDER BY round_id")?.query_map([], |r| Ok((r.get::<_, u32>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    assert_eq!(
        active,
        (0..2)
            .map(|i| {
                let payload = format!("{{\"text\":\"payload-{i}\"}}");
                (0, payload.clone(), payload)
            })
            .collect::<Vec<_>>()
    );
    assert_eq!(
        db.query_row(
            "SELECT semantic_state FROM btcc_turns WHERE turn_id='history-299999'",
            [],
            |r| r.get::<_, String>(0)
        )?,
        "admitted"
    );
    assert_eq!(
        db.query_row("SELECT count(*) FROM agent_acceptance_reclaims", [], |r| {
            r.get::<_, u64>(0)
        })?,
        0
    );
    assert_eq!(
        db.query_row(
            "SELECT state FROM agent_storage_corrections WHERE name='acceptance_payload_v1'",
            [],
            |r| r.get::<_, String>(0)
        )?,
        "done"
    );
    Ok(())
}

pub(super) fn cold(path: &Path) -> Result<(), HarnessError> {
    Connection::open(path)?.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
    butler_platform::secure_fs::sync_path(path)?;
    let file = std::fs::File::open(path)?;
    if let Some(result) = butler_platform::secure_fs::discard_cached_pages(&file) {
        result?;
    }
    Ok(())
}

pub(super) fn identities(path: &Path) -> Result<Vec<(String, String, String)>, HarnessError> {
    let db = Connection::open(path)?;
    Ok(db.prepare("SELECT acceptance_id,turn_id,round_id FROM btcc_model_round_acceptances ORDER BY acceptance_id")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}
