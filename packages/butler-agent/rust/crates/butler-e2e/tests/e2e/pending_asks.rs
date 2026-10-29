//! PA-01–PA-06: user-visible registry flows through the real gateway.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "E2E assertions"
)]
mod delegated;
mod queries;
mod regressions;
mod reminders;
mod stub;
use butler_e2e::e2e::{
    HarnessError,
    events::LiveEvents,
    gateway::turn_state,
    scenario::{Scenario, Setup},
};
use serde_json::{Value, json};
use std::time::Duration;

async fn setup(
    name: &str,
) -> Result<
    (
        Scenario,
        std::sync::Arc<stub::Script>,
        tokio::task::JoinHandle<()>,
    ),
    HarnessError,
> {
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new(name)?
        .access(butler_e2e::e2e::scenario::Access::AskAlways)
        .stub_cassette(butler_e2e::e2e::cassette::Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", url)
        .env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1");
    *script.root.lock().unwrap() = setup.sandbox.data.to_string_lossy().into_owned();
    let s = setup.start().await?;
    butler_e2e::e2e::fixtures::default_project_folder(&s).await?;
    Ok((s, script, server))
}
async fn asks(s: &Scenario, chat: &str) -> Result<Value, HarnessError> {
    let reply = s.gw.get(&format!("/sessions/{chat}/pending-asks")).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(reply.data().clone())
}
async fn ask(s: &Scenario, chat: &str) -> Result<Value, HarnessError> {
    let (_, turn) = s.turn(chat, stub::ASK).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let page = asks(s, chat).await?;
    assert_eq!(page["open_count"], 1);
    assert_eq!(page["asks"][0]["blocking"], false);
    assert_fields(s, chat, &page["asks"][0], true, Some("ask_user")).await?;
    Ok(page["asks"][0].clone())
}
async fn event(live: &LiveEvents, id: &Value, state: &str) -> Result<Value, HarnessError> {
    live.wait_for(Duration::from_secs(15), |e| {
        e["type"] == "pending_asks.changed"
            && e["payload"]["ask_id"] == *id
            && e["payload"]["state"] == state
    })
    .await
}
async fn chat(s: &Scenario, title: &str) -> Result<String, HarnessError> {
    let reply =
        s.gw.post("/sessions", json!({"title":title,"kind":"chat"}))
            .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    Ok(reply.data()["session"]["id"].as_str().unwrap().into())
}
#[tokio::test]
async fn pa_01_nonblocking_card_answer_removes_ask_and_emits_event() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server) = setup("PA-01").await?;
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    let q = ask(&s, "general").await?;
    assert_eq!(
        event(&live, &q["ask_id"], "open").await?["payload"]["open_count"],
        1
    );
    let reference = q["ask_id"]
        .as_str()
        .unwrap()
        .strip_prefix("question:")
        .unwrap();
    let reply =
        s.gw.post(
            &format!("/authority-requests/{reference}/answer?session_id=general"),
            crate::ask_user::answer(),
        )
        .await?;
    assert_eq!(reply.status, 202, "{}", reply.text);
    assert_eq!(
        event(&live, &q["ask_id"], "answered").await?["payload"]["open_count"],
        0
    );
    assert_eq!(asks(&s, "general").await?["asks"], json!([]));
    regressions::assert_followup(&s, &script, &q).await?;
    server.abort();
    s.finish().await
}
#[tokio::test]
async fn pa_02_global_approval_and_question_have_titles_and_stable_paging()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, _, server) = setup("PA-02").await?;
    let a = chat(&s, "Review chat").await?;
    let b = chat(&s, "Next step chat").await?;
    let id = s.gw.say_turn(&a, stub::APPROVE).await?;
    let turn =
        s.gw.wait_turn(
            &a,
            &id,
            &["waiting_for_form", "failed", "delivered"],
            Duration::from_secs(20),
        )
        .await?;
    assert_eq!(turn_state(&turn), "waiting_for_form", "{turn}");
    let q = ask(&s, &b).await?;
    let all = s.gw.get("/pending-asks?limit=1").await?;
    assert_eq!(all.status, 200, "{}", all.text);
    assert_eq!(all.data()["asks"].as_array().unwrap().len(), 1);
    assert_eq!(all.data()["asks"][0]["ask_id"], q["ask_id"]);
    assert_eq!(all.data()["asks"][0]["session_title"], "Next step chat");
    let cursor = all.data()["next_cursor"].as_str().unwrap();
    let encoded: String = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("before", cursor)
        .finish();
    let page =
        s.gw.get(&format!("/pending-asks?limit=1&{encoded}"))
            .await?;
    assert_eq!(page.data()["asks"][0]["kind"], "approval");
    assert_eq!(page.data()["asks"][0]["session_title"], "Review chat");
    assert_eq!(page.data()["next_cursor"], Value::Null);
    let approval = page.data()["asks"][0]["ask_id"].as_str().unwrap();
    let denied =
        s.gw.post(
            &format!("/sessions/{a}/pending-asks/{approval}/dismiss"),
            json!({}),
        )
        .await?;
    assert_eq!(denied.status, 409);
    assert_eq!(denied.body["error"]["code"], "approval_card_only");
    server.abort();
    s.finish().await
}
#[tokio::test]
async fn pa_05_archive_closes_questions_and_attention() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, _, server) = setup("PA-05").await?;
    let chat = chat(&s, "Questions").await?;
    let q = ask(&s, &chat).await?;
    attention(&s, &chat, true).await?;
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    let reply =
        s.gw.post(&format!("/sessions/{chat}/archive"), json!({}))
            .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert_eq!(
        event(&live, &q["ask_id"], "closed").await?["payload"]["open_count"],
        0
    );
    assert_eq!(asks(&s, &chat).await?["open_count"], 0);
    let reply =
        s.gw.patch(&format!("/sessions/{chat}"), json!({"archived":false}))
            .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    attention(&s, &chat, false).await?;
    assert_eq!(s.gw.get("/pending-asks").await?.data()["asks"], json!([]));
    server.abort();
    s.finish().await
}
#[tokio::test]
async fn pa_06_dismiss_survives_restart_and_the_next_turn() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, _, server) = setup("PA-06").await?;
    let q = ask(&s, "general").await?;
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    let reply =
        s.gw.post(
            &format!(
                "/sessions/general/pending-asks/{}/dismiss",
                q["ask_id"].as_str().unwrap()
            ),
            json!({}),
        )
        .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert_eq!(
        event(&live, &q["ask_id"], "dismissed").await?["payload"]["open_count"],
        0
    );
    s.restart().await?;
    let (_, turn) = s.turn("general", "Continue with the current work.").await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    assert_eq!(asks(&s, "general").await?["asks"], json!([]));
    let view = s.gw.get("/session-view?session_id=general").await?;
    assert_eq!(view.status, 200, "{}", view.text);
    assert_eq!(view.data()["pending_questions"], json!([]));
    assert_eq!(view.data()["question_answers"], json!([]));
    server.abort();
    s.finish().await
}

async fn attention(s: &Scenario, chat: &str, expected: bool) -> Result<(), HarnessError> {
    let nav = s.gw.get("/navigation").await?;
    let item = nav.data()["chats"]
        .as_array()
        .unwrap()
        .iter()
        .chain(
            nav.data()["projects"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|p| p["sessions"].as_array().into_iter().flatten()),
        )
        .find(|c| c["id"] == chat)
        .unwrap();
    assert_eq!(item["attention_required"], expected, "{item}");
    Ok(())
}
async fn assert_fields(
    s: &Scenario,
    chat: &str,
    ask: &Value,
    deferred: bool,
    call: Option<&str>,
) -> Result<(), HarnessError> {
    assert_eq!(ask["source_session_id"], chat);
    if let Some(tool) = call {
        let data = s.sandbox.data.clone();
        let id = ask["source_call_id"].as_str().unwrap().to_owned();
        let turn = ask["source_turn_id"].as_str().unwrap().to_owned();
        let name: String = tokio::task::spawn_blocking(move || {
            let db = butler_platform::sqlite::open(data.join("agent-runtime/btcc.sqlite"))?;
            Ok::<_, HarnessError>(db.query_row(
                "SELECT tool_name FROM btcc_guided_tool_calls WHERE call_id=?1 AND turn_id=?2",
                rusqlite::params![id, turn],
                |r| r.get(0),
            )?)
        })
        .await
        .map_err(|e| HarnessError(e.to_string()))??;
        assert_eq!(name, tool);
    } else {
        assert_eq!(ask["source_call_id"], Value::Null);
    }
    assert_eq!(ask["deferred"], deferred);
    chrono::DateTime::parse_from_rfc3339(ask["waiting_since"].as_str().unwrap()).unwrap();
    if chat != ask["session_id"].as_str().unwrap() {
        assert_eq!(ask["source_message_id"], Value::Null);
        return Ok(());
    }
    let view =
        s.gw.get(&format!("/session-view?session_id={chat}"))
            .await?;
    let messages = view.data()["messages"].as_array().unwrap();
    let message = messages
        .iter()
        .rev()
        .find(|m| m["role"] == "assistant" && m["turn_id"] == ask["source_turn_id"])
        .or_else(|| {
            messages
                .iter()
                .rev()
                .find(|m| m["role"] == "user" && m["turn_id"] == ask["source_turn_id"])
        })
        .unwrap();
    assert_eq!(ask["source_message_id"], message["id"]);
    Ok(())
}
