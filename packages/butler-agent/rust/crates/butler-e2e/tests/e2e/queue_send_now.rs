//! Send now uses Stop cancellation while keeping the session FIFO running.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
mod requires_e2e_fixtures;
mod stub;
use butler_e2e::e2e::{HarnessError, gateway::turn_state, scenario::Scenario};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use stub::Stub;

const ORIGINAL: &str = "Find citrus tea products and compare their ingredients.";
const CORRECTION: &str = "Exclude products with added sugar.";
const SECOND: &str = "Then compare the package sizes.";

async fn queue(s: &Scenario, text: &str) -> Result<String, HarnessError> {
    let reply =
        s.gw.post(
            "/session-queue",
            json!({"chat_id":"general", "text":text,
        "client_message_id":uuid::Uuid::new_v4().to_string()}),
        )
        .await?;
    assert_eq!(reply.status, 202, "{}", reply.text);
    Ok(reply.data()["queued_messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["text"] == text)
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .into())
}
fn path(id: &str) -> String {
    format!("/session-queue/{id}/send-now")
}
async fn view(s: &Scenario) -> Result<Value, HarnessError> {
    let reply = s.gw.get("/session-queue?chat_id=general").await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert_eq!(reply.data()["paused"], false, "{}", reply.text);
    Ok(reply.data().clone())
}
async fn sent(s: &Scenario, id: &str) -> Result<(), HarnessError> {
    let reply = s.gw.post(&path(id), json!({})).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert_eq!(reply.data()["paused"], false, "{}", reply.text);
    Ok(())
}
async fn turn_for(s: &Scenario, text: &str) -> Result<String, HarnessError> {
    let messages = s.gw.messages("general").await?;
    Ok(messages
        .iter()
        .find(|m| m["role"] == "user" && m["text"] == text)
        .unwrap_or_else(|| panic!("missing {text}: {messages:?}"))["turn_id"]
        .as_str()
        .unwrap()
        .into())
}
async fn terminal(s: &Scenario, id: &str, state: &str) -> Result<(), HarnessError> {
    let turn =
        s.gw.wait_terminal("general", id, Duration::from_secs(30))
            .await?;
    assert_eq!(turn_state(&turn), state, "{turn}");
    view(s).await?;
    Ok(())
}
fn cancel_count(s: &Scenario) -> usize {
    let db =
        rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite")).unwrap();
    db.query_row("SELECT count(*) FROM app_turn_cancel_outbox", [], |r| {
        r.get(0)
    })
    .unwrap()
}
async fn drain(s: &Scenario, stub: &mut Stub) -> Result<(), HarnessError> {
    stub.next().await.answer();
    let id = turn_for(s, CORRECTION).await?;
    terminal(s, &id, "delivered").await?;
    stub.next().await.answer();
    let id = turn_for(s, SECOND).await?;
    terminal(s, &id, "delivered").await?;
    let messages = s.gw.messages("general").await?;
    let texts: Vec<_> = messages
        .iter()
        .filter(|m| m["role"] == "user")
        .map(|m| m["text"].as_str().unwrap())
        .collect();
    assert_eq!(texts, [ORIGINAL, CORRECTION, SECOND]);
    assert_eq!(s.gw.turns("general").await?.len(), 3);
    Ok(())
}

#[tokio::test]
async fn owner_flow() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut stub, setup) = Stub::setup().await?;
    let s = setup.start().await?;
    stub.attach(&s)?;
    let running = s.gw.say_turn("general", ORIGINAL).await?;
    let held = stub.next().await;
    let correction = queue(&s, CORRECTION).await?;
    queue(&s, SECOND).await?;
    let started = Instant::now();
    sent(&s, &correction).await?;
    terminal(&s, &running, "cancelled").await?;
    let next = stub.next().await;
    let request = next.body.to_string();
    assert!(
        request.contains(ORIGINAL),
        "original request missing: {request}"
    );
    assert!(
        request.contains(CORRECTION),
        "correction missing: {request}"
    );
    let queued = view(&s).await?;
    assert_eq!(queued["queued_messages"].as_array().unwrap().len(), 1);
    assert_eq!(queued["queued_messages"][0]["text"], SECOND);
    assert_eq!(queued["queued_messages"][0]["state"], "queued");
    assert!(
        !s.gw
            .messages("general")
            .await?
            .iter()
            .any(|m| m["turn_id"] == running
                && m["role"] == "assistant"
                && m["status"] == "delivered")
    );
    let next_id = turn_for(&s, CORRECTION).await?;
    sent(&s, &correction).await?; // Already dispatching must not cancel its own turn.
    next.answer();
    terminal(&s, &next_id, "delivered").await?;
    sent(&s, &correction).await?; // Already dispatched remains a successful no-op.
    stub.next().await.answer();
    let last = turn_for(&s, SECOND).await?;
    terminal(&s, &last, "delivered").await?;
    let texts: Vec<_> =
        s.gw.messages("general")
            .await?
            .into_iter()
            .filter(|m| m["role"] == "user")
            .map(|m| m["text"].as_str().unwrap().to_owned())
            .collect();
    assert_eq!(texts, [ORIGINAL, CORRECTION, SECOND]);
    assert_eq!(s.gw.turns("general").await?.len(), 3);
    assert_eq!(cancel_count(&s), 1);
    held.answer();
    eprintln!(
        "send-now cancelled=1 ordered turns=3 elapsed={:?}",
        started.elapsed()
    );
    s.finish().await
}

#[tokio::test]
async fn double_click() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut stub, setup) = Stub::setup().await?;
    let s = setup.start().await?;
    stub.attach(&s)?;
    let running = s.gw.say_turn("general", ORIGINAL).await?;
    let held = stub.next().await;
    let correction = queue(&s, CORRECTION).await?;
    let (a, b) = tokio::join!(sent(&s, &correction), sent(&s, &correction));
    a?;
    b?;
    terminal(&s, &running, "cancelled").await?;
    stub.next().await.answer();
    let id = turn_for(&s, CORRECTION).await?;
    terminal(&s, &id, "delivered").await?;
    assert_eq!(s.gw.turns("general").await?.len(), 2);
    assert_eq!(cancel_count(&s), 1);
    held.answer();
    s.finish().await
}

#[tokio::test]
async fn not_next() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut stub, setup) = Stub::setup().await?;
    let s = setup.start().await?;
    stub.attach(&s)?;
    let running = s.gw.say_turn("general", ORIGINAL).await?;
    let held = stub.next().await;
    queue(&s, CORRECTION).await?;
    let second = queue(&s, SECOND).await?;
    let reply = s.gw.post(&path(&second), json!({})).await?;
    assert_eq!(reply.status, 409, "{}", reply.text);
    assert!(
        reply.text.contains("queued_message_not_next"),
        "{}",
        reply.text
    );
    assert_eq!(cancel_count(&s), 0);
    assert_eq!(
        view(&s).await?["queued_messages"].as_array().unwrap().len(),
        2
    );
    held.answer();
    terminal(&s, &running, "delivered").await?;
    drain(&s, &mut stub).await?;
    s.finish().await
}

#[tokio::test]
async fn finishing_turn() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut stub, setup) = Stub::setup().await?;
    let s = setup.start().await?;
    stub.attach(&s)?;
    let running = s.gw.say_turn("general", ORIGINAL).await?;
    let held = stub.next().await;
    let correction = queue(&s, CORRECTION).await?;
    // Stop leaves the head queued after its active turn has ended.
    let stop =
        s.gw.post(&format!("/turns/{running}/cancel"), json!({}))
            .await?;
    assert_eq!(stop.status, 202, "{}", stop.text);
    let turn =
        s.gw.wait_terminal("general", &running, Duration::from_secs(30))
            .await?;
    assert_eq!(turn_state(&turn), "cancelled");
    assert_eq!(
        s.gw.get("/session-queue?chat_id=general").await?.data()["paused"],
        true
    );
    sent(&s, &correction).await?;
    stub.next().await.answer();
    let id = turn_for(&s, CORRECTION).await?;
    terminal(&s, &id, "delivered").await?;
    assert_eq!(s.gw.turns("general").await?.len(), 2);
    assert_eq!(cancel_count(&s), 1);
    held.answer();
    s.finish().await
}

#[tokio::test]
async fn pending_approval() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut stub, setup) = Stub::setup().await?;
    let s = setup
        .access(butler_e2e::e2e::scenario::Access::AskAlways)
        .start()
        .await?;
    stub.attach(&s)?;
    let running = s.gw.say_turn("general", ORIGINAL).await?;
    stub.next().await.command();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if !s.gw.approval_requests("general").await?.is_empty() {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "approval never appeared\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let correction = queue(&s, CORRECTION).await?;
    sent(&s, &correction).await?;
    terminal(&s, &running, "cancelled").await?;
    assert_eq!(
        s.gw.approval_requests("general").await?,
        Vec::<Value>::new()
    );
    stub.next().await.answer();
    let id = turn_for(&s, CORRECTION).await?;
    terminal(&s, &id, "delivered").await?;
    s.finish().await
}
