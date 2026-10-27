use super::*;
use butler_e2e::e2e::scenario::turn_timeout;
use std::time::Duration;

pub(super) fn response(text: &str, reason: &str) -> String {
    message_start()
        + &start(0, &json!({"type":"text","text":""}))
        + &delta(0, &json!({"type":"text_delta","text":text}))
        + &message_end(reason, false)
}

async fn answer(s: &Scenario, id: &str) -> Result<Value, HarnessError> {
    Ok(s.gw
        .messages("general")
        .await?
        .into_iter()
        .find(|m| m["role"] == "assistant" && m["turn_id"] == id)
        .unwrap())
}

#[tokio::test]
async fn refusal_keeps_partial_and_fails_without_continuation() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, stub, server) = setup(false).await?;
    *stub.responses.lock().unwrap() = vec![response(PARTIAL, "refusal")];
    let (id, turn) = s.turn("general", "Explain the design.").await?;
    assert_eq!(turn_state(&turn), "failed", "{turn}");
    assert!(
        answer(&s, &id).await?["text"]
            .as_str()
            .unwrap()
            .contains(PARTIAL)
    );
    assert!(answer(&s, &id).await?["safe_error_code"].is_null());
    assert_eq!(stub.requests.lock().unwrap().len(), 1);
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn context_window_cut_fails_without_continuation() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, stub, server) = setup(false).await?;
    *stub.responses.lock().unwrap() = vec![response(PARTIAL, "model_context_window_exceeded")];
    let (id, turn) = s.turn("general", "Explain the design.").await?;
    assert_eq!(turn_state(&turn), "failed", "{turn}");
    assert_eq!(turn["safe_error_code"], "provider_context_limit_exceeded");
    assert_eq!(turn["retryable"], false);
    assert_eq!(answer(&s, &id).await?["text"], PARTIAL);
    assert_eq!(rounds(&stub).len(), 1);
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn pause_turn_resumes_with_trailing_assistant() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    resumes("pause_turn").await
}

async fn resumes(reason: &str) -> Result<(), HarnessError> {
    let (s, stub, server) = setup(false).await?;
    let continued = if reason == "pause_turn" {
        " off here and continues.\nThe end."
    } else {
        CONTINUED
    };
    *stub.responses.lock().unwrap() = vec![response(PARTIAL, reason), text_response(continued)];
    let (id, turn) = s.turn("general", "Explain the design.").await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    assert_eq!(answer(&s, &id).await?["text"], COMPLETE);
    let bodies = rounds(&stub);
    assert_eq!(bodies.len(), 2);
    if reason == "pause_turn" {
        let last = bodies[1]["messages"].as_array().unwrap().last().unwrap();
        let text = last["content"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v["text"].as_str())
            .collect::<String>();
        assert_eq!(
            text,
            text.trim_end(),
            "paused assistant has trailing whitespace"
        );
        assert_eq!(
            bodies[1]["messages"].as_array().unwrap().last().unwrap()["role"],
            "assistant"
        );
    }
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn two_cuts_join_exactly() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    two_cuts(false).await
}

#[tokio::test]
async fn schedule_two_cuts_join_exactly() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    two_cuts(true).await
}

async fn two_cuts(schedule: bool) -> Result<(), HarnessError> {
    let (s, stub, server) = setup(false).await?;
    *stub.responses.lock().unwrap() = vec![
        response(PARTIAL, "max_tokens"),
        response(CONTINUED, "max_tokens"),
        text_response("The end. Finished."),
    ];
    let (id, turn) = if schedule {
        let created =
            s.gw.post(
                "/automations",
                json!({"id":"design", "title":"Design",
            "prompt_body":"Explain the design.", "target_session_id":"general",
            "interval_seconds":3600, "access_mode":"read_only"}),
            )
            .await?;
        assert_eq!(created.status, 201, "{}", created.text);
        let run = s.gw.post("/automations/design/run", json!({})).await?;
        assert_eq!(run.status, 202, "{}", run.text);
        let id = run.data()["run"]["turn_id"].as_str().unwrap().to_owned();
        let turn =
            s.gw.wait_turn(
                "general",
                &id,
                &["delivered", "failed"],
                Duration::from_secs(turn_timeout()),
            )
            .await?;
        (id, turn)
    } else {
        s.turn("general", "Explain the design.").await?
    };
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    assert_eq!(
        answer(&s, &id).await?["text"],
        format!("{COMPLETE} Finished.")
    );
    assert_eq!(rounds(&stub).len(), 3);
    if schedule {
        let runs = s.gw.get("/automations/design/runs").await?;
        assert_eq!(runs.data()["runs"][0]["turn_id"], id, "{}", runs.text);
    }
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn final_continuation_can_repeat_an_earlier_line() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, stub, server) = setup(false).await?;
    let partial = "Example:\n```\nfirst line\nlast line";
    *stub.responses.lock().unwrap() = vec![
        response(partial, "max_tokens"),
        text_response("last line\n```"),
    ];
    let (id, turn) = s.turn("general", "Explain the example.").await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    assert_eq!(answer(&s, &id).await?["text"], format!("{partial}\n```"));
    assert_eq!(rounds(&stub).len(), 2);
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn repeated_cuts_stop_without_delivering_and_keep_partial() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for reason in ["max_tokens", "pause_turn"] {
        let (s, stub, server) = setup(false).await?;
        *stub.repeat.lock().unwrap() = Some(response(PARTIAL, reason));
        let (id, turn) = s.turn("general", "Explain the design.").await?;
        assert_eq!(turn_state(&turn), "failed", "{turn}");
        let messages = s.gw.messages("general").await?;
        let partial = messages
            .iter()
            .find(|m| m["turn_id"] == id && m["incomplete"] == true)
            .unwrap();
        assert_eq!(partial["text"], PARTIAL);
        let notice = messages
            .iter()
            .find(|m| m["turn_id"] == id && m["status"] == "failed")
            .unwrap();
        assert!(
            notice["text"]
                .as_str()
                .unwrap()
                .contains(if reason == "pause_turn" {
                    "paused and did not resume"
                } else {
                    "output limit"
                })
        );
        assert!(!notice["text"].as_str().unwrap().contains(PARTIAL));
        assert_eq!(stub.requests.lock().unwrap().len(), 2);
        s.finish().await?;
        server.abort();
    }
    Ok(())
}

#[tokio::test]
async fn continuation_http_failure_keeps_joined_partial() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, stub, server) = setup(false).await?;
    *stub.responses.lock().unwrap() = vec![
        response(PARTIAL, "max_tokens"),
        response(CONTINUED, "max_tokens"),
    ];
    *stub.fail_after.lock().unwrap() = Some(2);
    let (id, turn) = s.turn("general", "Explain the design.").await?;
    assert_eq!(turn_state(&turn), "failed", "{turn}");
    let messages = s.gw.messages("general").await?;
    let partial = messages
        .iter()
        .find(|m| m["turn_id"] == id && m["incomplete"] == true)
        .unwrap();
    assert_eq!(partial["text"], COMPLETE);
    assert_eq!(stub.requests.lock().unwrap().len(), 3);
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn pause_preserves_join_spacing_but_trims_wire() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, stub, server) = setup(false).await?;
    *stub.responses.lock().unwrap() =
        vec![response("Hello ", "pause_turn"), text_response("world")];
    let (id, turn) = s.turn("general", "Explain the design.").await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    assert_eq!(answer(&s, &id).await?["text"], "Hello world");
    let bodies = rounds(&stub);
    let content = &bodies[1]["messages"].as_array().unwrap().last().unwrap()["content"];
    let text = content
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|v| v["text"].as_str())
        .collect::<String>();
    assert_eq!(text, "Hello");
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn unrecognized_stop_offers_user_retry() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, stub, server) = setup(false).await?;
    *stub.responses.lock().unwrap() = vec![
        response(PARTIAL, "future_reason"),
        text_response("Recovered."),
    ];
    let (id, turn) = s.turn("general", "Explain the design.").await?;
    assert_eq!(turn_state(&turn), "failed", "{turn}");
    let messages = s.gw.messages("general").await?;
    let notice = messages
        .iter()
        .find(|m| m["turn_id"] == id && m["status"] == "failed")
        .unwrap();
    assert_eq!(notice["retryable"], true, "{notice}");
    assert_eq!(notice["retry_mode"], "fresh", "{notice}");
    assert_eq!(notice["safe_error_code"], "provider_stop_unrecognized");
    let rejected = s.gw.post(&format!("/turns/{id}/retry"), json!({})).await?;
    assert_eq!(rejected.status, 409, "{}", rejected.text);
    let retry =
        s.gw.post(&format!("/turns/{id}/retry-current"), json!({}))
            .await?;
    assert_eq!(retry.status, 202, "{}", retry.text);
    let next = butler_e2e::e2e::scenario::accepted_turn_id(retry.data())?;
    assert_ne!(next, id);
    let recovered =
        s.gw.wait_terminal("general", &next, Duration::from_secs(turn_timeout()))
            .await?;
    assert_eq!(turn_state(&recovered), "delivered", "{recovered}");
    assert_eq!(answer(&s, &next).await?["text"], "Recovered.");
    assert_eq!(answer(&s, &id).await?["text"], PARTIAL);
    let messages = s.gw.messages("general").await?;
    let notice = messages
        .iter()
        .find(|m| m["turn_id"] == id && m["status"] == "failed")
        .unwrap();
    assert_eq!(notice["retryable"], false, "{notice}");
    assert!(notice["retry_mode"].is_null(), "{notice}");
    s.restart().await?;
    let repeated =
        s.gw.post(&format!("/turns/{id}/retry-current"), json!({}))
            .await?;
    assert_eq!(repeated.status, 202, "{}", repeated.text);
    assert_eq!(
        butler_e2e::e2e::scenario::accepted_turn_id(repeated.data())?,
        next
    );
    assert_eq!(
        s.gw.messages("general")
            .await?
            .iter()
            .filter(|m| m["role"] == "user")
            .count(),
        2
    );
    assert_eq!(answer(&s, &next).await?["text"], "Recovered.");
    assert_eq!(stub.requests.lock().unwrap().len(), 2);
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn complete_round_trims_public_text() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, stub, server) = setup(false).await?;
    *stub.responses.lock().unwrap() = vec![text_response("\u{feff}Ready.\u{feff}")];
    let (id, turn) = s.turn("general", "Explain the design.").await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    assert_eq!(answer(&s, &id).await?["text"], "Ready.");
    s.finish().await?;
    server.abort();
    Ok(())
}

#[path = "continuation_and_tool_retry.rs"]
mod continuation_and_tool_retry;

#[path = "pause_and_fresh_retry.rs"]
mod pause_and_fresh_retry;
