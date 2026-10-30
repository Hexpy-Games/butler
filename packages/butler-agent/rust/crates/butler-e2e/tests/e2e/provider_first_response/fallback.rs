//! A first-response timeout moves the turn to a configured fallback model
//! without resending to the silent one, and each physical attempt of a
//! multi-attempt request is judged by its own first output.
use super::*;
use butler_e2e::e2e::binary::fixture_binary;
use tokio::process::Command;

/// The silent model gets one request; the fallback answers the turn.
#[tokio::test]
async fn fallback_answers_after_first_response_timeout() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let pace = Pace::FirstByteAfter(Duration::from_secs(120));
    let (silent, s) = paced("FIRST-RESPONSE-09", pace, 3_000).await?;
    let backup = FakeServer::local_models(ChatBehavior::default()).await?;
    let reply =
        s.gw.post(
            "/model-catalog/local-models",
            json!({
                "provider_id": "local", "api_type": "openai_compatible", "platform": "custom",
                "server_url": backup.base_url, "model_id": "backup-model",
                "display_name": "backup-model", "context_window_tokens": 131_072,
                "source": "manual"
            }),
        )
        .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    let fallback = json!({"model_fallback": {"enabled": true,
        "models": [reply.data()["model"]["model_ref"].clone()]}});
    let settings = s.gw.patch("/settings", fallback).await?;
    assert_eq!(settings.status, 200, "{}", settings.text);
    let ended = timed_turn(&s, PROMPT).await?;
    eprintln!(
        "FIRST-RESPONSE-09: {} after {:?}",
        turn_state(&ended.turn),
        ended.elapsed
    );
    assert_eq!(turn_state(&ended.turn), "delivered", "{}", ended.turn);
    assert_eq!(ended.text, ChatBehavior::default().answer);
    assert_eq!(rounds(&silent), 1, "the silent model got a resend");
    assert!(rounds(&backup) >= 1, "the fallback got no round");
    s.finish().await
}

/// Attempt 1 streams output and is cut; attempt 2 sends nothing until the
/// total limit. The timeout is reported for attempt 2's own state: no
/// first response, not a stall of attempt 1.
#[tokio::test]
async fn second_attempt_is_judged_by_its_own_first_output() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let server = FakeServer::local_models(ChatBehavior {
        cut_first_stream: true,
        hold_later_streams: Duration::from_secs(60),
        ..ChatBehavior::default()
    })
    .await?;
    let logs = std::env::temp_dir().join(format!("first-response-10-{}", std::process::id()));
    std::fs::create_dir_all(&logs)?;
    let (stdout, stderr) = (logs.join("out.json"), logs.join("err.log"));
    let started = Instant::now();
    // The companion's policy: total 10 s, no idle limit, 2 attempts.
    let status = Command::new(fixture_binary("e2e-provider-streaming")?)
        .args([
            format!("{}/v1/chat/completions", server.base_url),
            "qwen/qwen3.7-max".into(),
            "native".into(),
            "1".into(),
            "2".into(),
        ])
        .stdout(std::fs::File::create(&stdout)?)
        .stderr(std::fs::File::create(&stderr)?)
        .kill_on_drop(true)
        .status()
        .await?;
    eprintln!("FIRST-RESPONSE-10: exited after {:?}", started.elapsed());
    assert!(status.success(), "{}", std::fs::read_to_string(&stderr)?);
    let output: Value = serde_json::from_slice(&std::fs::read(&stdout)?)?;
    std::fs::remove_dir_all(&logs)?;
    assert_eq!(
        output["results"][0]["error"], FIRST_RESPONSE_TIMEOUT,
        "{output}"
    );
    assert_eq!(server.chat_requests().len(), 2, "{output}");
    Ok(())
}
