//! Sidebar unread state through the public App routes: a finished reply in a
//! background chat is unread, reading it on one client clears it on every
//! live client, and the read marker survives a restart. Streaming never
//! writes a marker; a repeated read writes nothing.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "E2E assertions"
)]
use butler_e2e::e2e::events::LiveEvents;
use butler_e2e::e2e::fake_servers::{ChatBehavior, FakeServer, LOCAL_MODEL};
use butler_e2e::e2e::gateway::turn_state;
use butler_e2e::e2e::scenario::{Fixture, Scenario, Setup};
use butler_e2e::e2e::{HarnessError, fixtures};
use butler_platform::sqlite;
use serde_json::json;
use std::time::Duration;

async fn start(server: &FakeServer) -> Result<Scenario, HarnessError> {
    let setup = Setup::new("UNREAD-01")?
        .fixture(Fixture::Empty)
        .env("BUTLER_OLLAMA_BASE_URL", server.base_url.clone());
    fixtures::onboarding_complete(&setup.sandbox.data)?;
    fixtures::scheduler_ran_today(&setup.sandbox.data, fixtures::FIXTURE_TIME)?;
    let s = setup.start().await?;
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
    Ok(s)
}

/// The chat's `unread` flag as the sidebar loads it.
async fn unread(s: &Scenario, chat: &str) -> Result<bool, HarnessError> {
    let navigation = s.gw.get("/navigation").await?;
    assert_eq!(navigation.status, 200, "{}", navigation.text);
    let row = navigation.data()["chats"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == chat)
        .cloned()
        .unwrap_or_else(|| panic!("{chat} missing from navigation"));
    Ok(row["unread"].as_bool().expect("unread is a boolean"))
}

async fn read(s: &Scenario, chat: &str) -> Result<bool, HarnessError> {
    let reply =
        s.gw.post(&format!("/sessions/{chat}/read"), json!({}))
            .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert_eq!(reply.data()["unread"], false, "{}", reply.text);
    Ok(reply.data()["changed"].as_bool().unwrap())
}

/// Read-marker rows and `session.read` events in the App database.
fn writes(s: &Scenario) -> Result<(i64, i64), HarnessError> {
    let db = sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let markers = db.query_row("SELECT COUNT(*) FROM app_session_reads", [], |row| {
        row.get(0)
    })?;
    let events = db.query_row(
        "SELECT COUNT(*) FROM events WHERE type='session.read'",
        [],
        |row| row.get(0),
    )?;
    Ok((markers, events))
}

/// A turn in `chat` whose reply streams slowly: while it streams the chat is
/// still read and nothing is written; once delivered it is unread.
async fn background_reply(s: &Scenario, chat: &str) -> Result<(), HarnessError> {
    let before = writes(s)?;
    let turn = s.gw.say_turn(chat, "Summarize local models.").await?;
    tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            let messages = s.gw.messages(chat).await?;
            if messages
                .iter()
                .any(|m| m["turn_id"] == turn.as_str() && m["status"] == "streaming")
            {
                return Ok::<_, HarnessError>(());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the reply never streamed")?;
    assert!(
        !unread(s, chat).await?,
        "a streaming reply is not unread yet"
    );
    let done =
        s.gw.wait_terminal(chat, &turn, Duration::from_secs(60))
            .await?;
    assert_eq!(turn_state(&done), "delivered", "{done}");
    assert!(unread(s, chat).await?, "the delivered reply is unread");
    assert_eq!(writes(s)?, before, "replies never write read markers");
    Ok(())
}

/// UNREAD-01 — background reply → unread; read on client 2 → cleared on
/// client 1 (live `session.read`); repeated read writes nothing; the read
/// survives a restart and a later reply is unread again, also after restart.
#[tokio::test]
async fn unread_01_reply_read_restart_and_second_client() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let server = FakeServer::local_models(ChatBehavior {
        chunk_delay: Duration::from_millis(60),
        ..ChatBehavior::default()
    })
    .await?;
    let mut s = start(&server).await?;
    let created =
        s.gw.post("/sessions", json!({"kind":"chat","title":"Background"}))
            .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let chat = created.data()["session"]["id"].as_str().unwrap().to_owned();
    assert!(!unread(&s, &chat).await?, "a chat without replies is read");
    assert!(!read(&s, &chat).await?, "nothing to read: no write");
    assert_eq!(writes(&s)?, (0, 0));

    background_reply(&s, &chat).await?;
    let first_client = LiveEvents::subscribe(&s.gw, 0).await?;
    assert!(read(&s, &chat).await?, "the second client reads the chat");
    let seen = first_client
        .wait_for(Duration::from_secs(5), |event| {
            event["type"] == "session.read" && event["payload"]["session_id"] == chat.as_str()
        })
        .await?;
    assert_eq!(seen["payload"]["unread"], false, "{seen}");
    assert!(!unread(&s, &chat).await?, "cleared for every client");
    assert!(!read(&s, &chat).await?, "a repeated read changes nothing");
    assert_eq!(writes(&s)?, (1, 1), "one marker and one event per read");

    s.restart().await?;
    assert!(!unread(&s, &chat).await?, "the read survives a restart");
    background_reply(&s, &chat).await?;
    s.restart().await?;
    assert!(
        unread(&s, &chat).await?,
        "an unread reply survives a restart"
    );
    assert!(read(&s, &chat).await?);
    assert!(!unread(&s, &chat).await?);
    assert_eq!(
        writes(&s)?,
        (1, 2),
        "the marker row moved; one event per read"
    );
    let missing = s.gw.post("/sessions/missing-chat/read", json!({})).await?;
    assert_eq!(
        missing.error_code(),
        Some("session_not_found"),
        "{}",
        missing.text
    );
    s.finish().await
}
