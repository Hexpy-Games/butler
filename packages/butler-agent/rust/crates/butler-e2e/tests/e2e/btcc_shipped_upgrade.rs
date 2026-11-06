//! A store from the shipped 0.1.0 manifest opens on upgrade and keeps its data.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use butler_e2e::e2e::{HarnessError, scenario::Setup};
use rusqlite::{Connection, params};

const NUMBERS: &str = "Write the numbers from one to twelve as English words, separated by single spaces, and nothing else.";
const SHIPPED_MANIFEST: &str = "ddf9f981df779464dbb2e74e888ee1fc66312337ba8f2a63f191dc02a1f5890f";
const SHIPPED_TABLES: [&str; 47] = [
    "btcc_admission_claims",
    "btcc_authority_requests",
    "btcc_canonical_deliveries",
    "btcc_checkpoints",
    "btcc_context_compactions",
    "btcc_context_documents",
    "btcc_continuation_triggers",
    "btcc_conversation_permissions",
    "btcc_delivery_outbox",
    "btcc_guided_effect_recovery_hints",
    "btcc_guided_effect_recovery_payloads",
    "btcc_guided_effects",
    "btcc_guided_tool_calls",
    "btcc_guided_turn_work_bindings",
    "btcc_guided_work_checkpoint_revisions",
    "btcc_guided_work_closeout_diagnostics",
    "btcc_guided_work_disposition_commands",
    "btcc_guided_work_disposition_revisions",
    "btcc_guided_work_effect_blockers",
    "btcc_guided_work_legacy_imports",
    "btcc_guided_work_mutations",
    "btcc_guided_work_plan_revisions",
    "btcc_guided_work_relation_commands",
    "btcc_guided_work_results",
    "btcc_guided_work_review_revisions",
    "btcc_guided_work_session_heads",
    "btcc_guided_works",
    "btcc_inbound_inbox",
    "btcc_messages",
    "btcc_model_round_acceptances",
    "btcc_model_route_events",
    "btcc_progress_events",
    "btcc_r3_legacy_turn_cutovers",
    "btcc_r3_legacy_turn_quarantine",
    "btcc_records",
    "btcc_runtime_owners",
    "btcc_session_relations",
    "btcc_state_claims",
    "btcc_steward_results",
    "btcc_stop_requests",
    "btcc_subsession_delegations",
    "btcc_subsession_directions",
    "btcc_subsession_outbox",
    "btcc_terminal_settlement_wakes",
    "btcc_turns",
    "btcc_wake_authorizations",
    "btcc_wake_request_facts",
];

#[tokio::test]
async fn shipped_store_opens_after_upgrade() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    upgrade("BTCC-SHIPPED-UPGRADE", &[]).await
}

/// An intermediate main build already created the Worker Task tables.
#[tokio::test]
async fn partial_runtime_store_opens_after_upgrade() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    upgrade(
        "BTCC-PARTIAL-UPGRADE",
        &["btcc_work_task_waits", "btcc_work_tasks"],
    )
    .await
}

async fn upgrade(name: &str, kept: &[&str]) -> Result<(), HarnessError> {
    let mut s = Setup::new(name)?
        .cassette("TURN-01")
        .replay_only()
        .start()
        .await?;
    s.turn("general", NUMBERS).await?;
    let before = s.gw.get("/session-view?session_id=general").await?;
    let messages = before.data()["messages"].clone();
    assert_eq!(messages.as_array().unwrap().len(), 2);
    s.agent.terminate().await?;
    let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    let db = Connection::open(&path)?;
    let upgraded = tables(&db)?;
    shipped(&db, kept)?;
    drop(db);
    s.gw = s.agent.start_again().await?;
    let view = s.gw.get("/session-view?session_id=general").await?;
    assert_eq!(view.status, 200);
    assert_eq!(
        view.data()["messages"],
        messages,
        "upgrade changed delivered content"
    );
    let db = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let restored = tables(&db)?;
    assert_eq!(restored, upgraded, "startup did not restore runtime tables");
    let manifest: String = db
        .prepare("SELECT manifest_id FROM agent_storage_migration_receipt WHERE singleton=1")?
        .query_row([], |row| row.get(0))?;
    assert_eq!(manifest, SHIPPED_MANIFEST);
    drop(db);
    s.finish().await
}

fn shipped(db: &Connection, kept: &[&str]) -> Result<(), HarnessError> {
    db.execute_batch("PRAGMA foreign_keys=OFF")?;
    let mut extra = tables(db)?;
    extra.retain(|name| !SHIPPED_TABLES.contains(&name.as_str()) && !kept.contains(&name.as_str()));
    let triggers: Vec<(String, String)> = db
        .prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'")?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (name, sql) in triggers {
        if extra.iter().any(|table| sql.contains(table.as_str())) {
            db.execute_batch(&format!("DROP TRIGGER \"{}\"", name.replace('"', "\"\"")))?;
        }
    }
    for table in extra {
        db.execute_batch(&format!("DROP TABLE \"{}\"", table.replace('"', "\"\"")))?;
    }
    let remaining = tables(db)?;
    let mut expected: Vec<&str> = SHIPPED_TABLES.iter().chain(kept).copied().collect();
    expected.sort_unstable();
    assert_eq!(remaining, expected);
    let raw: String = db
        .prepare("SELECT receipt_json FROM agent_storage_migration_receipt WHERE singleton=1")?
        .query_row([], |row| row.get(0))?;
    let mut receipt: serde_json::Value = serde_json::from_str(&raw)?;
    receipt["manifestId"] = SHIPPED_MANIFEST.into();
    receipt["tables"]
        .as_array_mut()
        .unwrap()
        .retain(|entry| SHIPPED_TABLES.contains(&entry["name"].as_str().unwrap()));
    assert_eq!(receipt["tables"].as_array().unwrap().len(), 47);
    db.execute("UPDATE agent_storage_migration_receipt SET manifest_id=?1,receipt_json=?2 WHERE singleton=1", params![SHIPPED_MANIFEST, receipt.to_string()])?;
    let raw: String = db
        .prepare("SELECT marker_json FROM agent_storage_activation_marker WHERE singleton=1")?
        .query_row([], |row| row.get(0))?;
    let mut marker: serde_json::Value = serde_json::from_str(&raw)?;
    marker["manifestId"] = SHIPPED_MANIFEST.into();
    db.execute("UPDATE agent_storage_activation_marker SET manifest_id=?1,marker_json=?2 WHERE singleton=1", params![SHIPPED_MANIFEST, marker.to_string()])?;
    Ok(())
}

fn tables(db: &Connection) -> rusqlite::Result<Vec<String>> {
    db.prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'btcc_%' ORDER BY name",
    )?
    .query_map([], |row| row.get::<_, String>(0))?
    .collect()
}
