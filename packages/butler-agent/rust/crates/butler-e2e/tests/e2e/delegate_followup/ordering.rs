//! Queued user input waits for delegated output through the public gateway.
use super::*;

#[tokio::test]
async fn child_result_precedes_followups_queued_while_parent_waits() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start(true).await?;
    let s = Setup::new("CHILD-RESULT-BEFORE-FOLLOWUPS")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", &url)
        .start()
        .await?;
    s.turn("general", stub::OWNER).await?;
    tokio::time::timeout(Duration::from_secs(20), script.held.notified())
        .await
        .unwrap();
    let followups = ["Keep the first note.", "Keep the second note."];
    for text in followups {
        let accepted =
            s.gw.post(
                "/session-queue",
                json!({
                    "chat_id":"general", "text":text,
                    "client_message_id":uuid::Uuid::new_v4().to_string()
                }),
            )
            .await?;
        assert_eq!(accepted.status, 202, "{accepted:?}");
    }
    assert!(
        !script
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|body| { followups.contains(&request_text(body).as_str()) })
    );
    script.release.notify_one();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let messages = s.gw.messages("general").await?;
        if messages
            .iter()
            .filter(|m| m["role"] == "assistant" && m["text"] == "{}" && m["status"] == "delivered")
            .count()
            == 2
        {
            let requests = script.requests.lock().unwrap();
            let ordered: Vec<_> = requests
                .iter()
                .map(request_text)
                .filter(|text| {
                    text.contains("Delegated result") || followups.contains(&text.as_str())
                })
                .collect();
            assert_eq!(ordered.len(), 3, "{ordered:?}");
            assert!(ordered[0].contains("Delegated result"), "{ordered:?}");
            assert_eq!(&ordered[1..], &followups, "{ordered:?}");
            let result = messages
                .iter()
                .position(|m| m["text"] == "원문 확인 결과를 정리했습니다.")
                .unwrap();
            for text in followups {
                assert!(
                    result
                        < messages
                            .iter()
                            .position(|m| m["role"] == "user" && m["text"] == text)
                            .unwrap()
                );
            }
            break;
        }
        assert!(
            Instant::now() < deadline,
            "{messages:?}\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    s.finish().await?;
    server.abort();
    Ok(())
}

fn request_text(body: &Value) -> String {
    butler_e2e::e2e::matching::key("/codex/responses", body, &Default::default()).user_request
}
