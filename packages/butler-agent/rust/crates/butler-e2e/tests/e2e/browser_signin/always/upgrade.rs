//! Upgrade an existing database while preserving its pending exact card and indexes.
use super::super::{
    host::{admin, attach, snapshot, tab},
    tool::waiting_card,
};
use super::{
    URL, observe,
    support::{begin, decide, delivered},
};
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::sync::Arc;

#[tokio::test]
async fn deployed_authority_scope_upgrades_without_losing_pending_cards() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let mut s = Setup::new("BROWSER-SITE-SCOPE-UPGRADE")?
        .stub_cassette(observe()?)
        .start()
        .await?;
    let host = attach_page(&s).await?;
    let id = begin(&s, "general").await?;
    let card = waiting_card(&s, &id).await?;
    drop(host);
    s.agent.terminate().await?;
    let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    let db = Connection::open(&path)?;
    let definition: String = db.query_row(
        "SELECT sql FROM sqlite_master WHERE name='btcc_authority_requests'",
        [],
        |row| row.get(0),
    )?;
    let old = definition.replace("'once', 'conversation', 'site'", "'once', 'conversation'");
    assert_ne!(definition, old);
    let indexes: Vec<String> = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='btcc_authority_requests' AND sql IS NOT NULL")?
        .query_map([], |row| row.get(0))?.collect::<Result<_, _>>()?;
    let triggers: Vec<String> = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name IN ('pending_ask_insert','pending_ask_update','pending_ask_suspended')")?
        .query_map([], |row| row.get(0))?.collect::<Result<_, _>>()?;
    db.execute_batch("BEGIN; DROP TRIGGER pending_ask_insert; DROP TRIGGER pending_ask_update; DROP TRIGGER pending_ask_suspended; ALTER TABLE btcc_authority_requests RENAME TO old_authority;")?;
    db.execute_batch(&old)?;
    db.execute_batch("INSERT INTO btcc_authority_requests SELECT * FROM old_authority; DROP TABLE old_authority;")?;
    for index in &indexes {
        db.execute_batch(index)?;
    }
    for trigger in &triggers {
        db.execute_batch(trigger)?;
    }
    db.execute_batch("COMMIT;")?;
    drop(db);
    s.gw = s.agent.start_again().await?;
    let _host = attach_page(&s).await?;
    let listed = s.gw.approval_requests("general").await?;
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["request_ref"], card["request_ref"]);
    decide(&s, "general", &listed[0], "site").await?;
    delivered(&s, "general", &id).await?;
    let db = Connection::open(&path)?;
    let scope: String = db.query_row(
        "SELECT allow_scope FROM btcc_authority_requests WHERE request_ref=?1",
        [card["request_ref"].as_str().unwrap()],
        |row| row.get(0),
    )?;
    assert_eq!(scope, "site");
    let permissions: i64 = db.query_row(
        "SELECT COUNT(*) FROM btcc_conversation_permissions",
        [],
        |row| row.get(0),
    )?;
    assert_eq!(
        permissions, 0,
        "site scope creates no BTCC standing permission"
    );
    for name in [
        "idx_btcc_questions_owner_turn",
        "idx_btcc_questions_deferred",
        "idx_btcc_permission_sources",
    ] {
        let exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name=?1 AND tbl_name='btcc_authority_requests')", params![name], |row| row.get(0))?;
        assert!(exists, "upgrade lost {name}");
    }
    drop(db);
    s.finish().await
}

async fn attach_page(
    s: &butler_e2e::e2e::scenario::Scenario,
) -> Result<super::super::host::Host, HarnessError> {
    let host = attach(
        s,
        Arc::new(|frame: Value| {
            Box::pin(async move {
                json!({"status":"ok","tab":frame["tab"],"url":URL,"obs":"o1","text":"Account"})
            })
        }),
    )
    .await?;
    snapshot(
        &admin(s),
        json!([tab("identity", "conversation:general", URL, "agent")]),
    )
    .await?;
    Ok(host)
}
