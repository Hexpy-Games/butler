//! Startup must preserve terminal legacy evidence and still quarantine unsafe reentry.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use butler_e2e::e2e::{HarnessError, scenario::Setup};
use rusqlite::{Connection, params};

const NUMBERS: &str = "Write the numbers from one to twelve as English words, separated by single spaces, and nothing else.";

#[tokio::test]
async fn terminal_history_filter_preserves_cutover_safety() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("CUTOVER-HISTORY")?
        .cassette("TURN-01")
        .replay_only()
        .start()
        .await?;
    let (kept, _) = s.turn("general", NUMBERS).await?;
    let (unsafe_turn, _) = s.turn("general", NUMBERS).await?;
    let before = s.gw.get("/session-view?session_id=general").await?;
    let messages = before.data()["messages"].clone();
    assert_eq!(messages.as_array().unwrap().len(), 4);
    s.agent.terminate().await?;
    let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    let db = Connection::open(&path)?;
    for turn in [kept.as_str(), unsafe_turn.as_str(), "missing-evidence-turn"] {
        insert_evidence(&db, turn)?;
    }
    db.execute(
        "UPDATE btcc_turns SET semantic_state='admitted' WHERE turn_id=?1",
        [&unsafe_turn],
    )?;
    let acceptances: i64 = db.query_row(
        "SELECT COUNT(*) FROM btcc_model_round_acceptances",
        [],
        |row| row.get(0),
    )?;
    drop(db);
    s.gw = s.agent.start_again().await?;
    let view = s.gw.get("/session-view?session_id=general").await?;
    assert_eq!(view.status, 200);
    assert_eq!(
        view.data()["messages"],
        messages,
        "restart changed delivered content"
    );
    assert_eq!(view.data()["latest_turn"]["id"], unsafe_turn);
    assert_eq!(view.data()["latest_turn"]["state"], "delivered");
    let db = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    assert_eq!(
        db.query_row(
            "SELECT COUNT(*) FROM btcc_model_round_acceptances",
            [],
            |row| row.get::<_, i64>(0)
        )?,
        acceptances,
        "startup reexecuted a model turn"
    );
    let reasons = db
        .prepare("SELECT turn_id,reason_json FROM btcc_r3_legacy_turn_quarantine ORDER BY turn_id")?
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    assert_eq!(reasons.len(), 2, "{reasons:?}");
    assert!(
        reasons.iter().any(|(turn, reason)| turn == &unsafe_turn
            && reason.contains("unsafe_legacy_reentry_evidence"))
    );
    assert!(
        reasons
            .iter()
            .any(|(turn, reason)| turn == "missing-evidence-turn"
                && reason.contains("cutover_evidence_turn_missing"))
    );
    assert!(reasons.iter().all(|(turn, _)| turn != &kept));
    drop(db);
    s.finish().await
}

fn insert_evidence(db: &Connection, turn: &str) -> Result<(), HarnessError> {
    db.execute("INSERT INTO btcc_r3_legacy_turn_cutovers(cutover_id,turn_id,source_semantic_state,source_turn_revision,source_execution_fence,admitted_checkpoint_id,admitted_turn_revision,admitted_execution_fence,evidence_json,evidence_sha256,cutover_at) VALUES(?1,?1,'planning',1,1,?1,2,2,'{}','fixture','2026-01-01T00:00:00Z')", params![turn])?;
    Ok(())
}
