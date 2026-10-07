//! Synthetic scale and interrupted cross-store ownership fixtures.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E assertions")]
use butler_e2e::e2e::HarnessError;
use butler_platform::sqlite;
use rusqlite::{OpenFlags, params};
use std::path::Path;

pub(super) fn seed_scale(data: &Path) -> Result<(), HarnessError> {
    let mut db = sqlite::open_with_flags(
        data.join("app-server/butler-client.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_WRITE,
    )?;
    let tx = db.transaction()?;
    tx.execute_batch("INSERT INTO app_automations(id,title,prompt_body,target_kind,target_session_id,interval_seconds,access_mode,state,last_run_state,created_at,updated_at) VALUES('kept-schedule','Kept schedule','Keep scheduling here','chat','general',3600,'full_access','paused','delivered','2026-01-01','2026-01-01'); INSERT INTO app_automation_runs(id,automation_id,target_session_id,state,trigger,started_at,completed_at,turn_id) SELECT 'kept-run','kept-schedule','general','delivered','manual','2026-01-01','2026-01-01',id FROM turns WHERE chat_id='general' LIMIT 1")?;
    {
        let mut insert = tx.prepare("INSERT INTO messages(id,chat_id,role,text,status,created_at,updated_at) VALUES(?1,'general','user',?2,'delivered','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')")?;
        for row in 0..100_000 {
            insert.execute(params![
                format!("scale-{row:06}"),
                format!("Scale message {row:06}")
            ])?;
        }
    }
    // Large unrelated transport history forces the rare clear to scan without new write indexes.
    for table in [
        "projected_transport_events",
        "app_transport_projection_receipts",
    ] {
        tx.execute_batch(&format!("WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<999999) INSERT INTO {table}(action_id,event_id,chat_id,created_at) SELECT 'scale-action-'||x,'scale-event-'||x||printf('%01200d',0),CASE WHEN x<100000 THEN 'general' ELSE 'other' END,'2026-01-01' FROM n"))?;
    }
    tx.commit()?;
    Ok(())
}

pub(super) fn ordered_message_ids(
    db: &rusqlite::Connection,
    chat: &str,
) -> Result<Vec<String>, HarnessError> {
    let mut rows = db.prepare("SELECT id FROM messages WHERE chat_id=?1 ORDER BY rowid")?;
    Ok(rows
        .query_map([chat], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

pub(super) fn seed_interrupted_output_transfer(
    data: &Path,
    archive: &str,
) -> Result<(), HarnessError> {
    use sha2::{Digest, Sha256};
    let db = sqlite::open(data.join("app-server/butler-client.sqlite"))?;
    db.execute("INSERT INTO app_output_transfers VALUES(?1)", [archive])?;
    db.execute(
        "INSERT INTO app_session_context_gate VALUES('general','relocate',?1)",
        [archive],
    )?;
    // Manifest/outputs already moved; source markers and historical refs remain.
    let outputs = sqlite::open(data.join("outputs/index.sqlite"))?;
    outputs.execute(
        "UPDATE output_refs SET session='general' WHERE session=?1",
        [archive],
    )?;
    let root = data.join("outputs/sessions");
    std::fs::rename(
        root.join(format!("{:x}", Sha256::digest(archive.as_bytes()))),
        root.join(format!("{:x}", Sha256::digest(b"general"))),
    )?;
    Ok(())
}

pub(super) async fn verify_rotated_permissions(
    s: &butler_e2e::e2e::scenario::Scenario,
    archive: &str,
) -> Result<(), HarnessError> {
    super::super::authority_permissions::seed::seed(s.sandbox.data.clone(), 3, false).await?;
    let app = sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let hint: String = app.query_row(
        "SELECT runtime_session_hint FROM chats WHERE id='general'",
        [],
        |r| r.get(0),
    )?;
    let btcc = sqlite::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    for (old, new) in [
        ("butler/app-chat-0", "butler/app-general"),
        ("butler/app-chat-1", hint.as_str()),
    ] {
        btcc.execute("UPDATE btcc_conversation_permissions SET owner_session_id=?2 WHERE owner_session_id=?1", params![old,new])?;
        btcc.execute(
            "UPDATE btcc_authority_requests SET owner_session_id=?2 WHERE owner_session_id=?1",
            params![old, new],
        )?;
    }
    let permissions = s.gw.get("/authority-permissions").await?;
    assert_eq!(permissions.status, 200, "{}", permissions.text);
    let grants = permissions.data()["permissions"].as_array().unwrap();
    assert_eq!(
        grants.iter().find(|g| g["session_id"] == hint).unwrap()["session_title"],
        "General"
    );
    let title: String = app.query_row("SELECT title FROM chats WHERE id=?1", [archive], |r| {
        r.get(0)
    })?;
    assert_eq!(
        grants
            .iter()
            .find(|g| g["session_id"] == "butler/app-general")
            .unwrap()["session_title"],
        title
    );
    Ok(())
}
