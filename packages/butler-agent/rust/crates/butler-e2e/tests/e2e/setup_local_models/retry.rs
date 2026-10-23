//! Turn routing owns retries and asks transport for one attempt. Exercise the
//! adapter's multi-attempt contract separately through its existing companion.
use super::*;
use butler_e2e::e2e::binary::fixture_binary;
use tokio::process::Command;

pub(super) async fn transport_retry(s: &Scenario, answer: &str) -> Result<(), HarnessError> {
    let server = FakeServer::local_models(ChatBehavior {
        cut_first_stream: true,
        ..ChatBehavior::default()
    })
    .await?;
    let stdout = s.sandbox.logs.join("transport-retry.json");
    let stderr = s.sandbox.logs.join("transport-retry.log");
    let mut child = Command::new(fixture_binary("e2e-provider-streaming")?)
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
        .spawn()?;
    let status = child.wait().await?;
    assert!(status.success(), "{}", std::fs::read_to_string(stderr)?);
    let output: Value = serde_json::from_slice(&std::fs::read(stdout)?)?;
    let events = output["events"].as_array().unwrap();
    let first = events
        .iter()
        .position(|event| event["type"] == "text_delta")
        .unwrap();
    let retry = events
        .iter()
        .position(|event| {
            event["type"] == "text_delta" && event["streamId"] != events[first]["streamId"]
        })
        .unwrap();
    assert!(
        events[first + 1..retry]
            .iter()
            .any(|event| event["type"] == "discarded"),
        "transport must discard cut text before retry deltas: {output}"
    );
    assert_eq!(output["results"][0]["text"], answer, "{output}");
    assert_eq!(server.chat_requests().len(), 2, "{output}");
    Ok(())
}
