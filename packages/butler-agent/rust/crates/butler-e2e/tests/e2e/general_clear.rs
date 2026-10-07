//! Clear the permanent channel through the authenticated public App route.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E assertions")]
use butler_e2e::e2e::fake_servers::{ChatBehavior, FakeServer, LOCAL_MODEL};
use butler_e2e::e2e::scenario::{Fixture, Setup, accepted_turn_id};
use butler_e2e::e2e::{HarnessError, fixtures};
use butler_platform::sqlite;
use rusqlite::{OpenFlags, params};
use serde_json::json;
use std::{
    path::Path,
    time::{Duration, Instant},
};

#[tokio::test]
async fn general_clear_archives_history_preserves_memory_and_starts_fresh()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let server = FakeServer::local_models(ChatBehavior::default()).await?;
    let setup = Setup::new("GENERAL-CLEAR")?
        .fixture(Fixture::Empty)
        .env("BUTLER_OLLAMA_BASE_URL", server.base_url.clone());
    fixtures::onboarding_complete(&setup.sandbox.data)?;
    fixtures::scheduler_ran_today(&setup.sandbox.data, fixtures::FIXTURE_TIME)?;
    let graph = super::memory_fixture::initialize_empty(&setup.sandbox.data)?;
    let memory = sqlite::open(&graph)?;
    memory.execute_batch("INSERT INTO memory_chunks(memory_chunk_id,source_key,current_revision,project_id,origin_kind,status,summary,summary_status,source_hash,created_at,updated_at) VALUES('kept-chat','kept-chat','v1',NULL,'user_input','active','Keep this chat memory.','ready','chat-hash','2026-01-01','2026-01-01'),('kept-project','kept-project','v1','fixture-project','user_input','active','Keep this project memory.','ready','project-hash','2026-01-01','2026-01-01')")?;
    drop(memory);
    let mut s = setup.start().await?;
    let model =
        s.gw.post(
            "/model-catalog/local-models",
            json!({
                "provider_id":"local", "api_type":"openai_compatible", "platform":"ollama",
                "server_url":server.base_url, "model_id":LOCAL_MODEL, "display_name":LOCAL_MODEL,
                "context_window_tokens":131_072, "source":"discovered"
            }),
        )
        .await?;
    assert_eq!(model.status, 201, "{}", model.text);
    let settings =
        s.gw.patch(
            "/settings",
            json!({"model":model.data()["model"]["model_ref"], "access_mode":"full_access"}),
        )
        .await?;
    assert_eq!(settings.status, 200, "{}", settings.text);
    let rules = s.sandbox.data.join("cognition/memory/rules");
    std::fs::create_dir_all(&rules)?;
    std::fs::write(rules.join("kept.md"), "Use concise explanations.")?;
    std::fs::write(
        rules.join("INDEX.md"),
        "- [Use concise explanations.](kept.md)\n",
    )?;
    let instructions = s.gw.get("/memory/instructions").await?.data().clone();
    s.turn("general", "Remember the cleararchiveunique marker.")
        .await?;
    let old = s.gw.messages("general").await?;
    assert!(old.len() >= 2);
    s.agent.terminate().await?;
    seed_scale(&s.sandbox.data)?;
    s.gw = s.agent.start_again().await?;
    let db = sqlite::open_with_flags(
        s.sandbox.data.join("app-server/butler-client.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let canonical = sqlite::open_with_flags(
        s.sandbox.data.join("runtime/conversation-store.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let before: String = canonical.query_row(
        "SELECT conversation_session_id FROM conversation_bindings WHERE gateway='app' AND external_session_id='butler/app-general'",
        [], |row| row.get(0),
    )?;
    let transcript: (String, i64) = db.query_row("SELECT transcript_path,projected_bytes FROM app_transcript_projection_checkpoints WHERE chat_id='general'", [], |row| Ok((row.get(0)?, row.get(1)?)))?;
    let transcript_bytes = std::fs::read(&transcript.0)?;
    let ordered_before = ordered_message_ids(&db, "general")?;
    let start = Instant::now();
    let cleared =
        s.gw.post(
            "/sessions/general/clear",
            json!({"title":"General · 10/7/2026"}),
        )
        .await?;
    assert_eq!(cleared.status, 200, "{}", cleared.text);
    eprintln!(
        "GENERAL-CLEAR messages=100002 elapsed={:?}",
        start.elapsed()
    );
    let archived = cleared.data()["archived_session"]["id"].as_str().unwrap();
    assert!(s.gw.messages("general").await?.is_empty());
    assert_eq!(ordered_message_ids(&db, archived)?, ordered_before);
    assert!(cleared.data()["session"]["latest_turn_id"].is_null());
    assert_eq!(
        cleared.data()["archived_session"]["active_turn_state"],
        "delivered"
    );
    let transferred: (String, i64) = db.query_row("SELECT transcript_path,projected_bytes FROM app_transcript_projection_checkpoints WHERE chat_id=?1", [archived], |row| Ok((row.get(0)?, row.get(1)?)))?;
    assert_eq!(transferred, transcript);
    assert_eq!(std::fs::read(&transferred.0)?, transcript_bytes);
    let archived_messages = s.gw.messages(archived).await?;
    assert!(!archived_messages.is_empty());
    let count: i64 = db.query_row(
        "SELECT COUNT(*) FROM messages WHERE chat_id=?1",
        [archived],
        |row| row.get(0),
    )?;
    assert_eq!(count, 100_000 + i64::try_from(old.len()).unwrap());
    for original in &old {
        let text: String = db.query_row(
            "SELECT text FROM messages WHERE id=?1 AND chat_id=?2",
            params![original["id"].as_str().unwrap(), archived],
            |row| row.get(0),
        )?;
        assert_eq!(text, original["text"].as_str().unwrap());
    }
    let corrupt: i64 = db.query_row("SELECT COUNT(*) FROM messages WHERE chat_id=?1 AND id LIKE 'scale-%' AND text != 'Scale message '||substr(id,7)", [archived], |row| row.get(0))?;
    assert_eq!(corrupt, 0);
    let indexed: i64 = db.query_row(
        "SELECT COUNT(*) FROM messages_fts f JOIN messages m ON m.rowid=f.rowid WHERE m.chat_id=?1",
        [archived],
        |row| row.get(0),
    )?;
    assert_eq!(indexed, count);
    let history_target: String = db.query_row(
        "SELECT target_session_id FROM app_automation_runs WHERE id='kept-run'",
        [],
        |row| row.get(0),
    )?;
    assert_eq!(history_target, archived);
    let schedule_target: String = db.query_row(
        "SELECT target_session_id FROM app_automations WHERE id='kept-schedule'",
        [],
        |row| row.get(0),
    )?;
    assert_eq!(schedule_target, "general");
    assert_eq!(
        s.gw.get("/memory/instructions").await?.data(),
        &instructions
    );
    let memory = sqlite::open_with_flags(&graph, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let kept: i64 = memory.query_row("SELECT COUNT(*) FROM memory_chunks WHERE (memory_chunk_id='kept-chat' AND summary='Keep this chat memory.' AND source_hash='chat-hash') OR (memory_chunk_id='kept-project' AND summary='Keep this project memory.' AND source_hash='project-hash' AND project_id='fixture-project')", [], |row| row.get(0))?;
    assert_eq!(kept, 2);
    drop(memory);
    let context: Option<String> = db.query_row(
        "SELECT conversation_session_id FROM chats WHERE id='general'",
        [],
        |row| row.get(0),
    )?;
    assert!(context.is_none());
    let preserved_hint: String = db.query_row(
        "SELECT runtime_session_hint FROM chats WHERE id=?1",
        [archived],
        |row| row.get(0),
    )?;
    let preserved: String = canonical.query_row(
        "SELECT conversation_session_id FROM conversation_bindings WHERE gateway='app' AND external_session_id=?1", [&preserved_hint], |row| row.get(0),
    )?;
    assert_eq!(preserved, before);
    let found: String = db.query_row("SELECT m.chat_id FROM messages_fts f JOIN messages m ON m.rowid=f.rowid WHERE messages_fts MATCH ?1", ["cleararchiveunique"], |row| row.get(0))?;
    assert_eq!(found, archived);
    let archives = s.gw.get("/archives").await?;
    assert!(archives.text.contains(archived));
    assert_eq!(s.gw.get("/navigation").await?.data()["archive_count"], 1);
    s.turn("general", "A fresh conversation.").await?;
    assert_eq!(s.gw.messages("general").await?.len(), 2);
    let requests = server.chat_requests();
    let fresh_request = requests.last().expect("fresh model request").to_string();
    assert!(fresh_request.contains("A fresh conversation."));
    assert!(!fresh_request.contains("cleararchiveunique"));
    let hint: String = db.query_row(
        "SELECT runtime_session_hint FROM chats WHERE id='general'",
        [],
        |row| row.get(0),
    )?;
    let fresh: String = canonical.query_row(
        "SELECT conversation_session_id FROM conversation_bindings WHERE gateway='app' AND external_session_id=?1", params![hint], |row| row.get(0),
    )?;
    assert_ne!(fresh, before);
    let running = accepted_turn_id(&s.gw.say("general", "Still running.").await?)?;
    let refused =
        s.gw.post(
            "/sessions/general/clear",
            json!({"title":"General · today"}),
        )
        .await?;
    assert_eq!(refused.status, 409, "{}", refused.text);
    assert!(refused.text.contains("session_busy"));
    s.gw.wait_terminal("general", &running, Duration::from_secs(30))
        .await?;
    let again =
        s.gw.post(
            "/sessions/general/clear",
            json!({"title":"General · later"}),
        )
        .await?;
    assert_eq!(again.status, 200, "{}", again.text);
    assert!(s.gw.messages("general").await?.is_empty());
    assert_ne!(again.data()["archived_session"]["id"], archived);
    drop(canonical);
    drop(db);
    s.finish().await
}

fn seed_scale(data: &Path) -> Result<(), HarnessError> {
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
    tx.commit()?;
    Ok(())
}

fn ordered_message_ids(db: &rusqlite::Connection, chat: &str) -> Result<Vec<String>, HarnessError> {
    let mut rows = db.prepare("SELECT id FROM messages WHERE chat_id=?1 ORDER BY rowid")?;
    Ok(rows
        .query_map([chat], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}
