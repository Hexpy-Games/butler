//! Upgrade fixtures emulate persisted pre-registry messages, never a new draft flow.
use super::*;
use butler_platform::sqlite;
use rusqlite::params;

#[tokio::test]
async fn pa_09_backfill_uses_only_latest_assistant_and_runs_once() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("PA-09")?.start().await?;
    s.agent.terminate().await?;
    let data = s.sandbox.data.clone();
    tokio::task::spawn_blocking(move || seed(&data))
        .await
        .map_err(|e| HarnessError(e.to_string()))??;
    s.gw = s.agent.start_again().await?;
    let all = s.gw.get("/pending-asks").await?;
    assert_eq!(all.data()["asks"].as_array().unwrap().len(), 1, "{all:?}");
    let q = &all.data()["asks"][0];
    assert_eq!(q["ask_id"], "plan:old-draft");
    assert_eq!(q["source_message_id"], "legacy-draft");
    assert_eq!(q["source_call_id"], Value::Null);
    assert_eq!(q["source_session_id"], "general");
    assert_eq!(q["deferred"], false);
    assert_eq!(q["waiting_since"], "2026-10-01T00:00:00Z");
    attention(&s, "general", false).await?;
    s.agent.terminate().await?;
    let data = s.sandbox.data.clone();
    tokio::task::spawn_blocking(move || {
        let db = sqlite::open(data.join("app-server/butler-client.sqlite"))?;
        let conversation = sqlite::open(data.join("runtime/conversation-store.sqlite"))?;
        super::queries::assert_index(
            &conversation,
            butler_turn::conversation::latest_assistant_message_statement(),
            "conversation_messages_turn_role_seq_idx",
        )?;
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM app_pending_ask_migrations WHERE version=1",
                [],
                |r| r.get::<_, i64>(0)
            )?,
            1
        );
        db.execute(
            "DELETE FROM app_open_plan_decisions WHERE chat_id='general'",
            [],
        )?;
        Ok::<_, HarnessError>(())
    })
    .await
    .map_err(|e| HarnessError(e.to_string()))??;
    s.gw = s.agent.start_again().await?;
    assert_eq!(
        asks(&s, "general").await?["open_count"],
        0,
        "marker must prevent resurrecting old drafts"
    );
    s.finish().await
}
fn seed(data: &std::path::Path) -> Result<(), HarnessError> {
    let conversation = sqlite::open(data.join("runtime/conversation-store.sqlite"))?;
    conversation.execute_batch("DROP INDEX conversation_messages_turn_role_seq_idx; DELETE FROM conversation_schema_migrations WHERE version=8; INSERT OR IGNORE INTO conversation_schema_migrations(version,applied_at) VALUES(7,'2026-10-01');")?;
    let db = sqlite::open(data.join("app-server/butler-client.sqlite"))?;
    db.execute("DELETE FROM app_pending_ask_migrations WHERE version=1", [])?;
    let plan = json!({"kind":"plan","id":"old-draft","title":"Saved draft","status":"draft","body":"Review the saved work."}).to_string();
    for (chat, archived) in [
        ("latest-plain", false),
        ("latest-active", false),
        ("archived-draft", true),
    ] {
        db.execute("INSERT INTO chats(id,title,kind,archived,created_at,updated_at) VALUES(?1,?1,'chat',?2,'2026-10-01','2026-10-01')", params![chat,archived])?;
        db.execute("INSERT INTO messages(id,chat_id,role,text,status,created_at,updated_at,plan_json) VALUES(?1,?2,'assistant','Saved draft','delivered','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z',?3)", params![format!("old-{chat}"),chat,plan])?;
    }
    db.execute("INSERT INTO messages(id,chat_id,role,text,status,created_at,updated_at,plan_json) VALUES('legacy-draft','general','assistant','Saved draft','delivered','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z',?1)", [&plan])?;
    db.execute("INSERT INTO messages(id,chat_id,role,text,status,created_at,updated_at) VALUES('latest-plain-message','latest-plain','assistant','No draft','delivered','2026-10-02T00:00:00Z','2026-10-02T00:00:00Z')", [])?;
    let mut active: Value = serde_json::from_str(&plan)?;
    active["status"] = json!("active");
    db.execute("INSERT INTO messages(id,chat_id,role,text,status,created_at,updated_at,plan_json) VALUES('latest-active-message','latest-active','assistant','Accepted','delivered','2026-10-02T00:00:00Z','2026-10-02T00:00:00Z',?1)", [active.to_string()])?;
    Ok(())
}
