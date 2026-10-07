//! Clear the permanent channel through the authenticated public App route.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E assertions")]
use butler_e2e::e2e::fake_servers::{ChatBehavior, FakeServer, LOCAL_MODEL};
use butler_e2e::e2e::scenario::{Fixture, Setup, accepted_turn_id};
use butler_e2e::e2e::{HarnessError, fixtures};
use butler_platform::sqlite;
use rusqlite::{OpenFlags, params};
use serde_json::json;
use std::time::{Duration, Instant};
mod ownership;
mod support;
use support::{
    ordered_message_ids, seed_interrupted_output_transfer, seed_scale, verify_rotated_permissions,
};

#[tokio::test]
async fn general_clear_archives_history_preserves_memory_and_starts_fresh()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let server = FakeServer::local_models(ChatBehavior::default()).await?;
    let setup = Setup::new("GENERAL-CLEAR")?
        .fixture(Fixture::Empty)
        .env("BUTLER_CLEAR_PROFILE", "1")
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
    let saved_upload =
        s.gw.upload(
            "saved.txt",
            "text/plain",
            b"Saved message file",
            Some("general"),
        )
        .await?;
    assert_eq!(saved_upload.status, 201, "{}", saved_upload.text);
    let saved_file = saved_upload.data()["file"]["file_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let sent = s.gw.post("/messages", json!({"chat_id":"general","text":"Remember the cleararchiveunique marker.","client_message_id":"saved-before-clear","attachments":[{"file_id":saved_file}]})).await?;
    assert_eq!(sent.status, 202, "{}", sent.text);
    let initial_turn = accepted_turn_id(sent.data())?;
    s.gw.wait_terminal("general", &initial_turn, Duration::from_secs(30))
        .await?;
    let upload =
        s.gw.upload(
            "pending.txt",
            "text/plain",
            b"Pending composer text",
            Some("general"),
        )
        .await?;
    assert_eq!(upload.status, 201, "{}", upload.text);
    let pending_file = upload.data()["file"]["file_id"]
        .as_str()
        .unwrap()
        .to_owned();
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
    let redundant: i64 = db.query_row("SELECT COUNT(*) FROM sqlite_schema WHERE type='index' AND name IN ('chats_conversation_idx','projected_transport_chat_idx','projection_receipts_chat_idx','staged_outbounds_chat_idx','terminal_projection_chat_idx')", [], |r| r.get(0))?;
    assert_eq!(redundant, 0);
    let ordered_before = ordered_message_ids(&db, "general")?;
    let db_bytes = std::fs::metadata(s.sandbox.data.join("app-server/butler-client.sqlite"))?.len();
    let probe =
        support::WriteProbe::start(s.sandbox.data.join("app-server/butler-client.sqlite")).await?;
    let start = Instant::now();
    let cleared =
        s.gw.post(
            "/sessions/general/clear",
            json!({"title":"General · 10/7/2026"}),
        )
        .await?;
    let write_lock = probe.finish().await?;
    eprintln!(
        "GENERAL-CLEAR max_write_lock_ms={:.3}",
        write_lock.as_secs_f64() * 1000.0
    );
    assert_eq!(cleared.status, 200, "{}", cleared.text);
    eprintln!(
        "GENERAL-CLEAR messages=100002 transport_rows=2000000 db_bytes={db_bytes} elapsed={:?}",
        start.elapsed()
    );
    for line in s
        .agent
        .logs()
        .lines()
        .filter(|line| line.contains("CLEAR-PROFILE"))
    {
        eprintln!("{line}");
    }
    let archived = cleared.data()["archived_session"]["id"].as_str().unwrap();
    assert!(s.gw.messages("general").await?.is_empty());
    assert_eq!(ordered_message_ids(&db, archived)?, ordered_before);
    let moved_file: String = db.query_row(
        "SELECT owner_session_id FROM message_files WHERE id=?1",
        [&saved_file],
        |r| r.get(0),
    )?;
    assert_eq!(moved_file, archived);
    assert_eq!(
        s.gw.download(&format!("/message-files/{saved_file}"))
            .await?
            .1,
        b"Saved message file"
    );
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
        "SELECT COUNT(*) FROM app_owned_messages WHERE chat_id=?1",
        [archived],
        |row| row.get(0),
    )?;
    assert_eq!(count, 100_000 + i64::try_from(old.len()).unwrap());
    for original in &old {
        let text: String = db.query_row(
            "SELECT text FROM app_owned_messages WHERE id=?1 AND chat_id=?2",
            params![original["id"].as_str().unwrap(), archived],
            |row| row.get(0),
        )?;
        assert_eq!(text, original["text"].as_str().unwrap());
    }
    let corrupt: i64 = db.query_row("SELECT COUNT(*) FROM app_owned_messages WHERE chat_id=?1 AND id LIKE 'scale-%' AND text != 'Scale message '||substr(id,7)", [archived], |row| row.get(0))?;
    assert_eq!(corrupt, 0);
    for table in [
        "projected_transport_events",
        "app_transport_projection_receipts",
    ] {
        let moved: i64 = db.query_row(
            &format!(
                "SELECT COUNT(*) FROM {table} WHERE chat_id=?1 AND action_id LIKE 'scale-action-%'"
            ),
            ["general"],
            |r| r.get(0),
        )?;
        let kept: i64 = db.query_row(
            &format!("SELECT COUNT(*) FROM {table} WHERE chat_id='other'"),
            [],
            |r| r.get(0),
        )?;
        assert_eq!((moved, kept), (100_000, 900_000));
    }
    let indexed: i64 = db.query_row(
        "SELECT COUNT(*) FROM messages_fts f JOIN app_owned_messages m ON m.rowid=f.rowid WHERE m.chat_id=?1",
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
    let found: String = db.query_row("SELECT m.chat_id FROM messages_fts f JOIN app_owned_messages m ON m.rowid=f.rowid WHERE messages_fts MATCH ?1", ["cleararchiveunique"], |row| row.get(0))?;
    assert_eq!(found, archived);
    let archives = s.gw.get("/archives").await?;
    assert!(archives.text.contains(archived));
    assert_eq!(s.gw.get("/navigation").await?.data()["archive_count"], 1);
    let sent = s.gw.post("/messages", json!({"chat_id":"general","text":"A fresh conversation.","client_message_id":"pending-after-clear","attachments":[{"file_id":pending_file}]})).await?;
    assert_eq!(sent.status, 202, "{}", sent.text);
    let sent_turn = accepted_turn_id(sent.data())?;
    s.gw.wait_terminal("general", &sent_turn, Duration::from_secs(30))
        .await?;
    let attached: String = db.query_row(
        "SELECT owner_session_id FROM message_files WHERE id=?1 AND message_id IS NOT NULL",
        [&pending_file],
        |row| row.get(0),
    )?;
    assert_eq!(attached, "general");
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
    butler_e2e::assert_wall_clock_budget!(
        write_lock,
        Duration::from_millis(500),
        "General clear writer exclusion"
    );
    drop(canonical);
    drop(db);
    s.finish().await
}

#[tokio::test]
async fn general_clear_preserves_outputs_and_routes_deferred_answers() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut cassette = super::browser_outputs::stub::cassette()?;
    cassette
        .exchanges
        .extend(super::ask_user::stub::cassette()?.exchanges);
    let mut s = Setup::new("GENERAL-CLEAR-OUTPUTS")?
        .stub_cassette(cassette)
        .start()
        .await?;
    s.turn("general", "Publish").await?;
    s.turn("general", "Again").await?;
    let before = s.gw.get("/artifacts?session_id=general").await?;
    let output = before.data()["artifacts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["kind"] == "web")
        .unwrap()
        .clone();
    let cleared =
        s.gw.post("/sessions/general/clear", json!({"title":"Saved outputs"}))
            .await?;
    assert_eq!(cleared.status, 200, "{}", cleared.text);
    let archive = cleared.data()["archived_session"]["id"].as_str().unwrap();
    assert_eq!(
        s.gw.get("/artifacts?session_id=general").await?.data()["artifacts"],
        json!([])
    );
    let kept =
        s.gw.get(&format!("/artifacts?session_id={archive}"))
            .await?;
    let kept_outputs = output_cards(kept.data());
    assert_eq!(kept_outputs.len(), 1);
    assert_eq!(kept_outputs[0]["id"], output["id"]);
    assert_eq!(kept_outputs[0]["session_id"], archive);
    assert!(s.gw.messages(archive).await?.iter().any(|m| {
        m["artifacts"]
            .as_array()
            .is_some_and(|a| a.iter().any(|a| a["id"] == output["id"]))
    }));
    s.agent.terminate().await?;
    seed_interrupted_output_transfer(&s.sandbox.data, archive)?;
    s.gw = s.agent.start_again().await?;
    let restored =
        s.gw.get(&format!("/artifacts?session_id={archive}"))
            .await?;
    assert_eq!(
        stable_artifacts(restored.data()),
        stable_artifacts(kept.data())
    );
    assert_eq!(
        s.gw.get("/artifacts?session_id=general").await?.data()["artifacts"],
        json!([])
    );
    verify_rotated_permissions(&s, archive).await?;
    let turn = accepted_turn_id(&s.gw.say("general", super::ask_user::stub::PROMPT).await?)?;
    s.gw.wait_turn(
        "general",
        &turn,
        &["waiting_for_form"],
        Duration::from_secs(20),
    )
    .await?;
    let view = s.gw.get("/session-view?session_id=general").await?;
    let q = view.data()["pending_questions"][0].clone();
    super::ask_user::reply(&s, &q, json!({"status":"deferred"})).await?;
    s.gw.wait_terminal("general", &turn, Duration::from_secs(20))
        .await?;
    super::ask_user::reply(&s, &q, super::ask_user::answer()).await?;
    let db = sqlite::open_with_flags(
        s.sandbox.data.join("app-server/butler-client.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let client: String = db.query_row("SELECT client_message_id FROM session_queued_messages WHERE chat_id='general' AND text LIKE 'Answers to your deferred questions:%'", [], |r| r.get(0))?;
    let deadline = Instant::now() + Duration::from_secs(20);
    let followup = loop {
        let dispatched: Option<String> = db.query_row("SELECT turn_id FROM session_queued_messages WHERE chat_id='general' AND client_message_id=?1", [&client], |r| r.get(0))?;
        if let Some(turn) = dispatched {
            break turn;
        }
        assert!(Instant::now() < deadline, "follow-up not dispatched");
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    s.gw.wait_terminal("general", &followup, Duration::from_secs(20))
        .await?;
    let view = s.gw.get("/session-view?session_id=general").await?;
    assert_eq!(view.data()["pending_questions"], json!([]));
    assert_eq!(
        view.data()["question_answers"][0]["response"],
        super::ask_user::answer()
    );
    let btcc = sqlite::open_with_flags(
        s.sandbox.data.join("agent-runtime/btcc.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let outcome: String = btcc.query_row(
        "SELECT outcome FROM btcc_authority_requests WHERE request_ref=?1",
        [q["request_ref"].as_str().unwrap()],
        |r| r.get(0),
    )?;
    assert_eq!(outcome, "applied");
    drop(btcc);
    let event: String = db.query_row(
        "SELECT payload_json FROM events WHERE type='question.answered' ORDER BY id DESC LIMIT 1",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&event)?["session_id"],
        "general"
    );
    s.agent.terminate().await?;
    let retry = sqlite::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    retry.execute(
        "UPDATE btcc_authority_requests SET outcome='pending' WHERE request_ref=?1",
        [q["request_ref"].as_str().unwrap()],
    )?;
    drop(retry);
    s.gw = s.agent.start_again().await?;
    let recovered = sqlite::open_with_flags(
        s.sandbox.data.join("agent-runtime/btcc.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let outcome: String = recovered.query_row(
        "SELECT outcome FROM btcc_authority_requests WHERE request_ref=?1",
        [q["request_ref"].as_str().unwrap()],
        |r| r.get(0),
    )?;
    assert_eq!(outcome, "applied");
    drop(recovered);
    let count: i64 = db.query_row(
        "SELECT COUNT(*) FROM session_queued_messages WHERE client_message_id=?1",
        [&client],
        |r| r.get(0),
    )?;
    assert_eq!(count, 1);
    let followups: i64 = db.query_row("SELECT COUNT(*) FROM session_queued_messages WHERE chat_id='general' AND text LIKE 'Answers to your deferred questions:%'", [], |r| r.get(0))?;
    assert_eq!(followups, 1);
    s.turn("general", "Publish").await?;
    let fresh_output = s.gw.get("/artifacts?session_id=general").await?;
    let fresh_cards = output_cards(fresh_output.data());
    assert_eq!(fresh_cards.len(), 1);
    assert_ne!(fresh_cards[0]["id"], output["id"]);
    let archived_again =
        s.gw.get(&format!("/artifacts?session_id={archive}"))
            .await?;
    assert_eq!(
        stable_artifacts(archived_again.data()),
        stable_artifacts(kept.data())
    );
    let deleted = s.gw.delete(&format!("/sessions/{archive}")).await?;
    assert_eq!(deleted.status, 200, "{}", deleted.text);
    s.turn("general", "Again").await?;
    let revised = s.gw.get("/artifacts?session_id=general").await?;
    let revised_cards = output_cards(revised.data());
    assert_eq!(revised_cards.len(), 1);
    assert_eq!(revised_cards[0]["id"], fresh_cards[0]["id"]);
    drop(db);
    s.finish().await
}

fn output_cards(view: &serde_json::Value) -> Vec<serde_json::Value> {
    view["artifacts"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|a| a["kind"] == "web")
        .cloned()
        .collect()
}

fn stable_artifacts(view: &serde_json::Value) -> Vec<serde_json::Value> {
    view["artifacts"]
        .as_array()
        .unwrap()
        .iter()
        .cloned()
        .map(|mut artifact| {
            // Signed download capabilities are renewed on each read, not stored history.
            artifact.as_object_mut().unwrap().remove("signed_url");
            artifact
        })
        .collect()
}
