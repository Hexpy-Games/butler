use super::*;
use butler_e2e::e2e::scenario::turn_timeout;
use std::time::Duration;

fn response(text: &str, reason: &str) -> String {
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
    assert_eq!(stub.requests.lock().unwrap().len(), 1);
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn context_window_cut_continues_and_joins() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    resumes("model_context_window_exceeded").await
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
