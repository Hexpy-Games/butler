//! Opt-in real-process startup qualification with terminal owner-scale history.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use rusqlite::{Connection, params};
use std::path::Path;
use std::time::Instant;
const ROWS: i64 = 85_000;

#[tokio::test]
async fn btcc_startup_scale_ready() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let Ok(evidence) = std::env::var("BUTLER_BTCC_STARTUP_EVIDENCE") else {
        return Ok(());
    };
    let label = std::env::var("BUTLER_BTCC_STARTUP_LABEL").unwrap_or_else(|_| "after".into());
    let mut s = Setup::new("BTCC-STARTUP-SCALE")?
        .env("BUTLER_E2E_STARTUP_TRACE", "1")
        .start()
        .await?;
    s.agent.terminate().await?;
    seed(&s.sandbox.data)?;
    let bytes = std::fs::metadata(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?.len();
    assert!(bytes >= 2_000_000_000);
    let mut measurements = Vec::new();
    for run in 1..=2 {
        let started = Instant::now();
        s.gw = s.agent.start_again().await?;
        let ready_ms = started.elapsed().as_secs_f64() * 1000.0;
        assert!(s.gw.healthy().await);
        complete(&s.sandbox.data)?;
        s.agent.terminate().await?;
        measurements.push(serde_json::json!({"run":run,"ready_ms":ready_ms,"bytes":bytes,"rows":ROWS,"cache":"warm; no privileged cache purge"}));
        std::fs::write(
            Path::new(&evidence).join(format!("{label}-{run}.log")),
            std::fs::read(s.sandbox.logs.join(format!("agent-{}.log", run + 1)))?,
        )?;
    }
    std::fs::write(
        Path::new(&evidence).join(format!("{label}.json")),
        serde_json::to_vec_pretty(&measurements)?,
    )?;
    // The large fixture is removed by the sandbox's successful teardown.
    s.sandbox.mark_success();
    Ok(())
}

fn complete(data: &Path) -> Result<(), HarnessError> {
    let db = Connection::open(data.join("agent-runtime/btcc.sqlite"))?;
    for (table, key) in [
        ("btcc_turns", "turn_id"),
        ("btcc_inbound_inbox", "inbox_id"),
        ("btcc_session_relations", "relation_id"),
        ("btcc_subsession_outbox", "outbox_id"),
    ] {
        let (count, first, last): (i64, String, String) = db.query_row(
            &format!(
                "SELECT COUNT(*),MIN({key}),MAX({key}) FROM {table} WHERE {key} LIKE 'history-%'"
            ),
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        assert_eq!(count, ROWS);
        assert_eq!(first, "history-000000");
        assert_eq!(last, "history-084999");
    }
    for id in ["history-000000", "history-084999"] {
        let body: String = db.query_row(
            "SELECT original_message FROM btcc_turns WHERE turn_id=?1",
            [id],
            |row| row.get(0),
        )?;
        assert_eq!(body, "x".repeat(23_000));
    }
    Ok(())
}

fn seed(data: &Path) -> Result<(), HarnessError> {
    let mut db = Connection::open(data.join("agent-runtime/btcc.sqlite"))?;
    // These are terminal historical rows. No recovery/model work is required.
    for start in (0..ROWS).step_by(5_000) {
        let tx = db.transaction()?;
        {
            let mut inbox = tx.prepare("INSERT INTO btcc_inbound_inbox(inbox_id,session_id,trigger_key,turn_id,admission_input_hash,command_json,status) VALUES(?1,'history',?1,?1,'fixture','{}','constructed')")?;
            let mut relation = tx.prepare("INSERT INTO btcc_session_relations(relation_id,parent_session_id,parent_turn_id,child_session_id,anchor_message_id,ordinal,safe_title,created_at,activity_role,activity_worker_id,activity_terminal) VALUES(?1,'history',?1,?1,?1,?2,'Historical child','2026-01-01T00:00:00Z','steward',?1,1)")?;
            let mut turn = tx.prepare("INSERT INTO btcc_turns(turn_id,session_id,inbox_id,trigger_key,original_message_id,original_message,admission_snapshot_ref,model_selection_json,context_json,semantic_state,revision,execution_fence) VALUES(?1,'history',?1,?1,?1,?2,'fixture','{}','{}','delivered',1,1)")?;
            let mut outbox = tx.prepare("INSERT INTO btcc_subsession_outbox(outbox_id,relation_id,result_id,parent_session_id,parent_turn_id,message_id,input_json,status,created_at) VALUES(?1,?1,?1,'history',?1,?1,'{}','delivered','2026-01-01T00:00:00Z')")?;
            let body = "x".repeat(23_000);
            for index in start..(start + 5_000).min(ROWS) {
                let id = format!("history-{index:06}");
                inbox.execute([&id])?;
                relation.execute(params![id, index])?;
                turn.execute(params![id, body])?;
                outbox.execute([id])?;
            }
        }
        tx.commit()?;
        db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
    }
    eprintln!(
        "PERF-BTCC database_bytes={}",
        std::fs::metadata(data.join("agent-runtime/btcc.sqlite"))?.len()
    );
    Ok(())
}
