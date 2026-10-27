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
async fn fresh_retry_refuses_failure_after_effecting_tool() -> Result<(), HarnessError> {
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
    *stub.responses.lock().unwrap() = vec![tool_response(path.to_str().unwrap())];
    *stub.fail_after.lock().unwrap() = Some(1);
    *stub.fail_status.lock().unwrap() = 503;
    let (id, turn) = s.turn("general", "Write the file and explain.").await?;
    assert_eq!(turn_state(&turn), "failed", "{turn}");
    assert_eq!(std::fs::read_to_string(&path)?, "original");
    let messages = s.gw.messages("general").await?;
    let failure = messages
        .iter()
        .find(|m| m["turn_id"] == id && m["status"] == "failed")
        .unwrap();
    assert_eq!(failure["retryable"], false, "{failure}");
    assert!(failure["retry_mode"].is_null(), "{failure}");
    let retry =
        s.gw.post(&format!("/turns/{id}/retry-current"), json!({}))
            .await?;
    assert_eq!(retry.status, 409, "{}", retry.text);
    assert_eq!(std::fs::read_to_string(&path)?, "original");
    let calls: i64 = {
        let db = butler_platform::sqlite::open_with_flags(
            s.sandbox.data.join("agent-runtime/btcc.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        db.query_row(
            "SELECT COUNT(*) FROM btcc_guided_tool_calls WHERE turn_id=?1",
            [&id],
            |r| r.get(0),
        )?
    };
    assert_eq!(calls, 1, "effecting tool executed more than once");
    let bodies = stub.requests.lock().unwrap().clone();
    assert!(bodies.len() > 2, "automatic retries were not exhausted");
    assert_eq!(
        bodies
            .iter()
            .filter(|body| body["messages"].as_array().unwrap().len() == 1)
            .count(),
        1
    );
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
