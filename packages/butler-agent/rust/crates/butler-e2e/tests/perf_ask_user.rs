//! Wall-clock coverage for pending-question session views runs in the perf tier.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

#[path = "ask_user/scale.rs"]
mod scale;
#[path = "ask_user/stub.rs"]
mod stub;

use butler_e2e::e2e::{
    HarnessError,
    gateway::turn_state,
    scenario::{Scenario, Setup, accepted_turn_id},
};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

fn answer() -> Value {
    json!({"status":"answered","answers":[{"id":"format","selected":["full"],"custom":null,"skipped":false}]})
}

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
    Ok((s, turn, question))
}

#[tokio::test]
async fn perf_ask_user_pending_question_session_view_p95_under_150ms() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, turn, question) = pending("ASK-USER-PERF").await?;
    scale::seed_history(&s, &question).await?;
    let mut samples = Vec::with_capacity(20);
    for _ in 0..20 {
        let started = Instant::now();
        let view = s.gw.get("/session-view?session_id=general").await?;
        samples.push(started.elapsed());
        assert_eq!(view.status, 200, "{}", view.text);
        assert_eq!(view.data()["pending_questions"], json!([question]));
        assert_eq!(view.data()["question_answers"], json!([]));
        assert_eq!(view.data()["authority_requests"], json!([]));
        assert_eq!(view.data()["active_turn"]["id"], turn);
        assert_eq!(view.data()["latest_turn"]["id"], turn);
        assert_eq!(view.data()["latest_turn"]["state"], "waiting_for_form");
    }
    samples.sort();
    let p50 = samples[9];
    let p95 = samples[18];
    eprintln!("ask_user session-view p50 {p50:?}; p95 {p95:?}");
    assert!(p95 < Duration::from_millis(150), "session-view p95 {p95:?}");
    s.finish().await
}
