//! Repeated uploads retain every identity, metadata field, and durable byte.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E assertions")]
use butler_e2e::e2e::{HarnessError, cassette::Cassette, scenario::Setup};
use serde_json::Value;

#[tokio::test]
async fn uploads_preserve_distinct_metadata_and_complete_bytes_after_restart()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("UPLOAD-CONTENT")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .start()
        .await?;
    let inputs = [
        (
            "first.txt",
            "text/plain",
            b"complete first content\n".as_slice(),
        ),
        (
            "second.txt",
            "text/plain",
            b"complete first content\n".as_slice(),
        ),
        (
            "newest.txt",
            "text/plain",
            b"complete newest content\n".as_slice(),
        ),
        (
            "again.txt",
            "text/plain",
            b"complete first content\n".as_slice(),
        ),
        (
            "first.jpg",
            "image/jpeg",
            include_bytes!("../../fixtures/browser-route/observation.jpg").as_slice(),
        ),
        (
            "second.jpg",
            "image/jpeg",
            include_bytes!("../../fixtures/browser-route/observation.jpg").as_slice(),
        ),
    ];
    let mut files = Vec::new();
    for (name, mime, bytes) in inputs {
        let reply = s.gw.upload(name, mime, bytes, Some("general")).await?;
        assert_eq!(reply.status, 201, "{}", reply.text);
        let file = reply.data()["file"].clone();
        assert_eq!(file["safe_name"], name);
        assert_eq!(file["size_bytes"], bytes.len());
        assert_eq!(file["mime_type"], mime);
        assert_eq!(
            file["kind"],
            if mime == "image/jpeg" {
                "image"
            } else {
                "text"
            }
        );
        assert_ne!(file["created_at"].as_str().unwrap(), "");
        files.push(file);
    }
    let ids: std::collections::HashSet<_> = files
        .iter()
        .map(|file| file["file_id"].as_str().unwrap())
        .collect();
    assert_eq!(ids.len(), inputs.len());
    for (file, (_, _, bytes)) in files.iter().zip(inputs) {
        assert_download(&s, file, bytes).await?;
    }
    s.gw = s.agent.restart().await?;
    for (file, (_, _, bytes)) in files.iter().zip(inputs) {
        assert_download(&s, file, bytes).await?;
    }
    s.finish().await
}

async fn assert_download(
    s: &butler_e2e::e2e::scenario::Scenario,
    file: &Value,
    expected: &[u8],
) -> Result<(), HarnessError> {
    let response =
        s.gw.http()
            .get(format!(
                "{}/message-files/{}",
                s.gw.base,
                file["file_id"].as_str().unwrap()
            ))
            .bearer_auth(&s.gw.token)
            .send()
            .await?;
    assert_eq!(response.status(), 200);
    assert_eq!(response.bytes().await?.as_ref(), expected);
    Ok(())
}
