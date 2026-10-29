use super::*;

#[tokio::test]
async fn consecutive_pauses_count_new_provider_blocks_as_progress() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, stub, server) = setup(false).await?;
    let blocks = message_start()
        + &start(
            0,
            &json!({"type":"server_tool_use","id":"search-1","name":"web_search","input":{"query":"weather"}}),
        )
        + &stop(0)
        + &start(
            1,
            &json!({"type":"web_search_tool_result","tool_use_id":"search-1","content":[]}),
        )
        + &stop(1)
        + &message_end("pause_turn", true);
    *stub.responses.lock().unwrap() = vec![
        response("Starting. ", "pause_turn"),
        blocks,
        text_response("Finished."),
    ];
    let (id, turn) = s.turn("general", "Explain the design.").await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    assert_eq!(answer(&s, &id).await?["text"], "Starting. Finished.");
    assert_eq!(rounds(&stub).len(), 3);
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn failure_before_tools_can_retry_exactly_once() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, stub, server) = setup(false).await?;
    let created =
        s.gw.post(
            "/sessions",
            json!({"kind":"chat","title":"Retry relocation"}),
        )
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let chat = created.data()["session"]["id"].as_str().unwrap().to_owned();
    s.patch_settings(json!({"language":"ko"}), "App language")
        .await?;
    *stub.fail_after.lock().unwrap() = Some(0);
    *stub.fail_status.lock().unwrap() = 503;
    let (id, turn) = s.turn(&chat, "Explain the design.").await?;
    assert_eq!(turn_state(&turn), "failed", "{turn}");
    let messages = s.gw.messages(&chat).await?;
    let notice = messages
        .iter()
        .find(|m| m["turn_id"] == id && m["status"] == "failed")
        .unwrap();
    assert!(
        notice["text"]
            .as_str()
            .unwrap()
            .contains("작업을 더 진행하지 못했습니다"),
        "{notice}"
    );
    assert_eq!(notice["retryable"], true, "{notice}");
    assert_eq!(notice["retry_mode"], "fresh", "{notice}");
    *stub.fail_after.lock().unwrap() = None;
    *stub.repeat.lock().unwrap() = Some(text_response("Recovered."));
    let retry =
        s.gw.post(&format!("/turns/{id}/retry-current"), json!({}))
            .await?;
    assert_eq!(retry.status, 202, "{}", retry.text);
    let next = s.gw.accepted_turn(retry.data()).await?;
    let recovered =
        s.gw.wait_terminal(&chat, &next, Duration::from_secs(turn_timeout()))
            .await?;
    assert_eq!(turn_state(&recovered), "delivered", "{recovered}");
    assert!(
        s.gw.messages(&chat)
            .await?
            .iter()
            .any(|m| m["turn_id"] == next && m["text"] == "Recovered.")
    );
    let notice =
        s.gw.messages(&chat)
            .await?
            .into_iter()
            .find(|m| m["turn_id"] == id && m["status"] == "failed")
            .unwrap();
    assert_eq!(notice["retryable"], false, "{notice}");
    s.restart().await?;
    let retry =
        s.gw.post(&format!("/turns/{id}/retry-current"), json!({}))
            .await?;
    assert_eq!(retry.status, 202, "{}", retry.text);
    assert_eq!(s.gw.accepted_turn(retry.data()).await?, next);
    assert_eq!(
        s.gw.messages(&chat)
            .await?
            .iter()
            .filter(|m| m["role"] == "user")
            .count(),
        2
    );
    butler_e2e::e2e::fixtures::default_project_folder(&s).await?;
    let project =
        s.gw.post(
            "/projects",
            json!({"source":"scratch","display_name":"Retry destination"}),
        )
        .await?;
    assert_eq!(project.status, 201, "{}", project.text);
    let navigation = s.gw.get("/navigation").await?;
    let moved =
        s.gw.post(
            "/space/relocations",
            json!({
                "operationId":"retry-relocation", "sessionId":chat,
                "expectedRevision":navigation.data()["space"]["revision"],
                "targetKey":format!("p:{}", project.data()["project"]["id"].as_str().unwrap()),
                "position":"inside"
            }),
        )
        .await?;
    assert_eq!(moved.status, 200, "{}", moved.text);
    s.finish().await?;
    server.abort();
    Ok(())
}
