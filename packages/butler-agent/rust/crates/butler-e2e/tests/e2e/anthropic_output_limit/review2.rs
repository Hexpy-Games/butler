use super::*;

#[tokio::test]
async fn complete_repeating_only_last_line_delivers_joined_answer() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, stub, server) = setup(false).await?;
    *stub.responses.lock().unwrap() = vec![
        response(PARTIAL, "max_tokens"),
        text_response("The second line is cut"),
    ];
    let (id, turn) = s.turn("general", "Explain the design.").await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    assert_eq!(answer(&s, &id).await?["text"], PARTIAL);
    assert_eq!(rounds(&stub).len(), 2);
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn cut_repeating_earlier_content_is_not_progress() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, stub, server) = setup(false).await?;
    let partial = "First line\nMiddle line\nLast line";
    *stub.responses.lock().unwrap() = vec![
        response(partial, "max_tokens"),
        response("Last lineMiddle line", "max_tokens"),
    ];
    let (id, turn) = s.turn("general", "Explain the design.").await?;
    assert_eq!(turn_state(&turn), "failed", "{turn}");
    assert_eq!(answer(&s, &id).await?["text"], partial);
    assert_eq!(rounds(&stub).len(), 2);
    s.finish().await?;
    server.abort();
    Ok(())
}

fn tool_response(path: &str) -> String {
    message_start()
        + &start(
            0,
            &json!({"type":"tool_use","id":"effect","name":"tool_call","input":{}}),
        )
        + &delta(
            0,
            &json!({"type":"input_json_delta","partial_json":json!({"id":"native:write_file","arguments":{"path":path,"content":"original"}}).to_string()}),
        )
        + &stop(0)
        + &message_end("tool_use", true)
}

#[tokio::test]
async fn fresh_retry_after_tools_and_later_turn_appends_without_replaying_effects()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, stub, server) = setup(false).await?;
    let controls =
        s.gw.patch(
            "/sessions/general/controls",
            json!({"access_mode":"full_access"}),
        )
        .await?;
    assert_eq!(controls.status, 200, "{}", controls.text);
    let path = s.sandbox.workspace.join("effect.txt");
    *stub.responses.lock().unwrap() = vec![
        tool_response(path.to_str().unwrap()),
        response(PARTIAL, "future_reason"),
        text_response("Later answer."),
        text_response("Retried answer."),
    ];
    let (id, turn) = s.turn("general", "Write the file and explain.").await?;
    assert_eq!(turn_state(&turn), "failed", "{turn}");
    assert_eq!(std::fs::read_to_string(&path)?, "original");
    std::fs::write(&path, "after failure")?;
    let original = s.gw.messages("general").await?;
    let (later, turn) = s.turn("general", "A later question.").await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let retry =
        s.gw.post(&format!("/turns/{id}/retry-current"), json!({}))
            .await?;
    assert_eq!(retry.status, 202, "{}", retry.text);
    let next = butler_e2e::e2e::scenario::accepted_turn_id(retry.data())?;
    assert_ne!(next, id);
    let turn =
        s.gw.wait_terminal("general", &next, Duration::from_secs(turn_timeout()))
            .await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    assert_eq!(std::fs::read_to_string(path)?, "after failure");
    let messages = s.gw.messages("general").await?;
    for old in original.iter().filter(|m| m["turn_id"] == id) {
        assert_eq!(messages.iter().find(|m| m["id"] == old["id"]), Some(old));
    }
    let later_index = messages
        .iter()
        .position(|m| m["turn_id"] == later && m["role"] == "assistant")
        .unwrap();
    let next_index = messages
        .iter()
        .position(|m| m["turn_id"] == next && m["role"] == "assistant")
        .unwrap();
    assert!(next_index > later_index);
    assert_eq!(messages[next_index]["text"], "Retried answer.");
    assert_eq!(stub.requests.lock().unwrap().len(), 4);
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn empty_pause_resends_no_empty_assistant() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, stub, server) = setup(false).await?;
    *stub.responses.lock().unwrap() = vec![response("", "pause_turn"), text_response("Finished.")];
    let (id, turn) = s.turn("general", "Explain the design.").await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    assert_eq!(answer(&s, &id).await?["text"], "Finished.");
    let bodies = stub.requests.lock().unwrap().clone();
    assert_eq!(bodies.len(), 2);
    for message in bodies[1]["messages"].as_array().unwrap() {
        if message["role"] == "assistant" {
            assert_ne!(message["content"], json!([]));
            assert_ne!(message["content"], json!([{"type":"text","text":""}]));
        }
    }
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn tool_round_clears_cut_before_empty_response_recovery() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, stub, server) = setup(false).await?;
    let path = s.sandbox.workspace.join("effect.txt");
    *stub.responses.lock().unwrap() = vec![
        response(PARTIAL, "max_tokens"),
        tool_response(path.to_str().unwrap()),
        text_response(""),
        text_response("Fresh answer."),
    ];
    let (id, turn) = s.turn("general", "Write the file and explain.").await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    assert_eq!(answer(&s, &id).await?["text"], "Fresh answer.");
    let bodies = rounds(&stub);
    assert_eq!(bodies.len(), 4);
    assert!(last_user_text(&bodies[3]).contains("empty"));
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn limit_notice_uses_app_language_for_english_request() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, stub, server) = setup(false).await?;
    s.patch_settings(json!({"language":"ko"}), "Korean app language")
        .await?;
    *stub.repeat.lock().unwrap() = Some(response(PARTIAL, "pause_turn"));
    let (id, turn) = s.turn("general", "Explain the design.").await?;
    assert_eq!(turn_state(&turn), "failed", "{turn}");
    let messages = s.gw.messages("general").await?;
    let failure = messages
        .iter()
        .find(|m| m["turn_id"] == id && m["status"] == "failed")
        .unwrap();
    assert_eq!(
        failure["text"],
        "모델이 일시 중지 후 이어서 답하지 않았습니다."
    );
    s.finish().await?;
    server.abort();
    Ok(())
}
