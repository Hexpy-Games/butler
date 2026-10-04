//! Structured user questions exercise the same App decision and resume path as approvals.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
#[path = "ask_user/scale.rs"]
pub(super) mod scale;
#[path = "ask_user/stub.rs"]
pub(super) mod stub;
use butler_e2e::e2e::{
    HarnessError,
    gateway::turn_state,
    scenario::{Scenario, Setup, accepted_turn_id},
};
use butler_platform::sqlite;
use serde_json::{Value, json};
use std::time::Duration;

async fn pending(name: &str) -> Result<(Scenario, String, Value), HarnessError> {
    let s = Setup::new(name)?
        .stub_cassette(stub::cassette()?)
        .start()
        .await?;
    let turn = accepted_turn_id(&s.gw.say("general", stub::PROMPT).await?)?;
    let parked =
        s.gw.wait_turn(
            "general",
            &turn,
            &["waiting_for_form", "failed", "delivered"],
            Duration::from_secs(20),
        )
        .await?;
    assert_eq!(turn_state(&parked), "waiting_for_form", "{parked}");
    let view = s.gw.get("/session-view?session_id=general").await?;
    assert_eq!(view.status, 200, "{}", view.text);
    let question = view.data()["pending_questions"][0].clone();
    assert_eq!(question["questions"], stub::questions());
    assert_attention(&s, true).await?;
    Ok((s, turn, question))
}
fn answer() -> Value {
    json!({"status":"answered","answers":[{"id":"format","selected":["full"],"custom":null,"skipped":false}]})
}
async fn reply(s: &Scenario, q: &Value, response: Value) -> Result<Value, HarnessError> {
    let response =
        s.gw.post(
            &format!(
                "/authority-requests/{}/answer?session_id=general",
                q["request_ref"].as_str().unwrap()
            ),
            response,
        )
        .await?;
    assert_eq!(response.status, 202, "{}", response.text);
    Ok(response.data().clone())
}
async fn completed(s: &Scenario, turn: &str) -> Result<(), HarnessError> {
    let done =
        s.gw.wait_terminal("general", turn, Duration::from_secs(20))
            .await?;
    assert_eq!(turn_state(&done), "delivered", "{done}");
    let requests = s.provider()?.requests();
    assert_eq!(requests.len(), 2, "extra model round: {requests:?}");
    let input = requests[1]["input"].as_array().unwrap();
    assert!(
        input
            .iter()
            .any(|item| item["type"] == "function_call_output"
                && item["output"]
                    .as_str()
                    .is_some_and(|s| s.contains("full") && s.contains("answered"))),
        "answer missing from model input: {input:?}"
    );
    let view = s.gw.get("/session-view?session_id=general").await?;
    assert_eq!(view.data()["pending_questions"], json!([]));
    assert_eq!(view.data()["question_answers"][0]["response"], answer());
    assert_attention(s, false).await?;
    Ok(())
}
#[tokio::test]
async fn ask_user_answer_continues_same_turn() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, turn, q) = pending("ASK-USER").await?;
    scale::seed_history(&s, &q).await?;
    for _ in 0..20 {
        let view = s.gw.get("/session-view?session_id=general").await?;
        assert_eq!(view.status, 200, "{}", view.text);
        assert_eq!(view.data()["pending_questions"], json!([q]));
        assert_eq!(view.data()["question_answers"], json!([]));
        assert_eq!(view.data()["authority_requests"], json!([]));
        assert_eq!(view.data()["active_turn"]["id"], turn);
        assert_eq!(view.data()["latest_turn"]["id"], turn);
        assert_eq!(view.data()["latest_turn"]["state"], "waiting_for_form");
    }
    measure_idle(&s, &q).await?;
    let invalid =
        s.gw.post(
            &format!(
                "/authority-requests/{}/answer?session_id=general",
                q["request_ref"].as_str().unwrap()
            ),
            json!({"status":"answered","answers":[]}),
        )
        .await?;
    assert_eq!(invalid.status, 400);
    assert_eq!(s.provider()?.requests().len(), 1);
    let wrong_session =
        s.gw.post(
            &format!(
                "/authority-requests/{}/answer?session_id=unrelated",
                q["request_ref"].as_str().unwrap()
            ),
            answer(),
        )
        .await?;
    assert_eq!(wrong_session.status, 404);
    for malicious in [
        json!({"status":"answered","answers":[{"id":"format","selected":["not-an-option"],"custom":null}]}),
        json!({"status":"answered","answers":[{"id":"format","selected":["full"],"custom":null}],"allow_scope":"conversation"}),
    ] {
        let rejected =
            s.gw.post(
                &format!(
                    "/authority-requests/{}/answer?session_id=general",
                    q["request_ref"].as_str().unwrap()
                ),
                malicious,
            )
            .await?;
        assert_eq!(rejected.status, 400);
    }
    assert_eq!(s.provider()?.requests().len(), 1);
    let forbidden =
        s.gw.post(
            &format!(
                "/authority-requests/{}/allow?session_id=general",
                q["request_ref"].as_str().unwrap()
            ),
            json!({"scope":"conversation"}),
        )
        .await?;
    assert_eq!(forbidden.status, 400, "question granted permission");
    reply(&s, &q, answer()).await?;
    completed(&s, &turn).await?;
    s.finish().await
}
#[tokio::test]
async fn ask_user_restart_pending_keeps_question_and_queued_followup() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, turn, q) = pending("ASK-USER-RESTART").await?;
    // A pending question retains the active queue claim; follow-ups stay queued across shutdown.
    let queued = s.gw.post("/session-queue", json!({"chat_id":"general","text":stub::PROMPT,"client_message_id":"ask-user-followup"})).await?;
    assert_eq!(queued.status, 202, "{}", queued.text);
    s.restart().await?;
    let view = s.gw.get("/session-view?session_id=general").await?;
    assert_eq!(view.data()["pending_questions"][0], q);
    let queue = s.gw.get("/session-queue?session_id=general").await?;
    assert!(
        queue.data()["queued_messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["text"] == stub::PROMPT && item["state"] == "queued"),
        "{}",
        queue.text
    );
    reply(&s, &q, answer()).await?;
    let done =
        s.gw.wait_terminal("general", &turn, Duration::from_secs(20))
            .await?;
    assert_eq!(turn_state(&done), "delivered");
    // Cancel the now-active queued question, then restart: no pending form remains.
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    let id = loop {
        let requests = s.gw.approval_requests("general").await?;
        if let Some(q) = requests
            .iter()
            .find(|q| q["category"] == "ask_user" && q["source_turn_id"] != turn)
        {
            break q["source_turn_id"].as_str().unwrap().to_owned();
        }
        assert!(
            std::time::Instant::now() < deadline,
            "queued question never resumed: {:?}",
            s.provider()?.misses()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    let cancel = s.gw.post(&format!("/turns/{id}/cancel"), json!({})).await?;
    assert_eq!(cancel.status, 202);
    s.gw.wait_terminal("general", &id, Duration::from_secs(20))
        .await?;
    s.restart().await?;
    assert_eq!(
        s.gw.get("/session-view?session_id=general").await?.data()["pending_questions"],
        json!([])
    );
    let stale = s.gw.post(
        &format!("/authority-requests/{}/answer?session_id=general", q["request_ref"].as_str().unwrap()),
        json!({"status":"answered","answers":[{"id":"format","selected":["short"],"custom":null}]}),
    ).await?;
    assert!((400..500).contains(&stale.status), "stale answer accepted");
    s.finish().await
}

#[tokio::test]
async fn ask_user_deferred_restores_and_later_answer_enters_existing_queue()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, turn, q) = pending("ASK-USER-LATER").await?;
    reply(&s, &q, json!({"status":"deferred"})).await?;
    let done =
        s.gw.wait_terminal("general", &turn, Duration::from_secs(20))
            .await?;
    assert_eq!(turn_state(&done), "delivered");
    let requests = s.provider()?.requests();
    assert_eq!(requests.len(), 2);
    assert!(requests[1]["input"].as_array().unwrap().iter().any(|item| {
        item["type"] == "function_call_output"
            && item["output"]
                .as_str()
                .is_some_and(|s| s.contains("deferred"))
    }));
    s.restart().await?;
    let view = s.gw.get("/session-view?session_id=general").await?;
    assert_eq!(
        view.data()["pending_questions"].as_array().unwrap().len(),
        1
    );
    assert_eq!(
        view.data()["pending_questions"][0]["question_state"],
        "deferred"
    );
    reply(&s, &q, answer()).await?;
    // The stable client id makes a repeated submission exactly one follow-up.
    reply(&s, &q, answer()).await?;
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    loop {
        let view = s.gw.get("/session-view?session_id=general").await?;
        if view.data()["latest_turn"]["state"] == "delivered"
            && view.data()["latest_turn"]["id"] != turn
        {
            assert_eq!(view.data()["pending_questions"], json!([]));
            assert_eq!(view.data()["question_answers"][0]["response"], answer());
            assert_attention(s, false).await?;
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "later answer did not continue: {} {:?}",
            view.text,
            s.provider()?.misses()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(s.provider()?.requests().len(), 3);
    let input = s.provider()?.requests()[2]["input"].to_string();
    assert!(input.contains("Answers to your deferred questions") && input.contains("full"));
    s.finish().await
}

async fn measure_idle(s: &Scenario, question: &Value) -> Result<(), HarnessError> {
    let data = s.sandbox.data.clone();
    let readers = tokio::task::spawn_blocking(move || {
        [
            "agent-runtime/btcc.sqlite",
            "app-server/butler-client.sqlite",
        ]
        .map(|path| {
            let db = sqlite::open_with_flags(
                data.join(path),
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .unwrap();
            let version: u64 = db
                .pragma_query_value(None, "data_version", |r| r.get(0))
                .unwrap();
            (db, version)
        })
    })
    .await
    .map_err(|e| HarnessError(e.to_string()))?;
    let start = std::time::Instant::now();
    tokio::time::sleep(Duration::from_secs(60)).await;
    let changes = tokio::task::spawn_blocking(move || {
        readers.map(|(db, before)| {
            let after: u64 = db
                .pragma_query_value(None, "data_version", |r| r.get(0))
                .unwrap();
            after - before
        })
    })
    .await
    .map_err(|e| HarnessError(e.to_string()))?;
    let view = s.gw.get("/session-view?session_id=general").await?;
    assert_eq!(view.data()["pending_questions"], json!([question]));
    assert_eq!(s.provider()?.requests().len(), 1);
    eprintln!(
        "ask_user idle_window={:?} btcc_commits={} app_commits={} complete_pending_questions=1 model_calls=1",
        start.elapsed(),
        changes[0],
        changes[1]
    );
    assert_eq!(changes, [0, 0], "idle question storage writes");
    Ok(())
}

async fn assert_attention(s: &Scenario, expected: bool) -> Result<(), HarnessError> {
    let nav = s.gw.get("/navigation").await?;
    assert_eq!(nav.status, 200);
    let general = nav.data()["chats"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == "general")
        .unwrap();
    assert_eq!(general["attention_required"], expected, "{general}");
    Ok(())
}
