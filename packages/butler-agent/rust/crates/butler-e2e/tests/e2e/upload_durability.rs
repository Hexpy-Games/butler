//! Concurrent fresh uploads, row authority, and startup-only orphan recovery.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E assertions")]
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use serde_json::Value;

#[tokio::test]
async fn concurrent_uploads_survive_restart_and_orphans_stay_unreadable() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let mut s = Setup::new("UPLOAD-DURABILITY")?.start().await?;
    let bytes: Vec<Vec<u8>> = (1..=4).map(|byte| vec![byte; 64 * 1024]).collect();
    let replies = tokio::join!(
        s.gw.upload(
            "first.bin",
            "application/octet-stream",
            &bytes[0],
            Some("general")
        ),
        s.gw.upload(
            "second.bin",
            "application/octet-stream",
            &bytes[1],
            Some("general")
        ),
        s.gw.upload(
            "third.bin",
            "application/octet-stream",
            &bytes[2],
            Some("general")
        ),
        s.gw.upload(
            "fourth.bin",
            "application/octet-stream",
            &bytes[3],
            Some("general")
        ),
    );
    let mut files = Vec::new();
    for reply in [replies.0?, replies.1?, replies.2?, replies.3?] {
        assert_eq!(reply.status, 201, "{}", reply.text);
        files.push(reply.data()["file"].clone());
    }
    for (file, expected) in files.iter().zip(&bytes) {
        assert_bytes(&s, file, expected).await?;
    }
    let root = s.sandbox.data.join("app-server/message-files");
    let orphan = format!("file-{}", uuid::Uuid::new_v4());
    let orphan_path = root.join(format!("{orphan}.upload"));
    std::fs::write(&orphan_path, b"uncommitted bytes")?;
    let (status, _) = s.gw.download(&format!("/message-files/{orphan}")).await?;
    assert_eq!(
        status, 404,
        "filesystem presence never grants row authority"
    );
    let other = root.join(format!("file-{}", uuid::Uuid::new_v4()));
    std::fs::write(&other, b"another producer awaiting projection")?;
    let interrupted = root.join(format!(".{orphan}.upload.123.0.1.tmp"));
    std::fs::write(&interrupted, b"interrupted platform publication")?;
    s.agent.terminate().await?;
    s.gw = s.agent.start_again().await?;
    assert!(!orphan_path.exists(), "startup removes uncommitted uploads");
    assert!(
        !interrupted.exists(),
        "startup removes interrupted fallback files"
    );
    assert!(
        other.exists(),
        "other file producers retain their own lifecycle"
    );
    for (file, expected) in files.iter().zip(&bytes) {
        assert_bytes(&s, file, expected).await?;
    }
    s.finish().await
}

async fn assert_bytes(
    s: &butler_e2e::e2e::scenario::Scenario,
    file: &Value,
    expected: &[u8],
) -> Result<(), HarnessError> {
    let id = file["file_id"].as_str().unwrap();
    let head =
        s.gw.http()
            .head(format!("{}/message-files/{id}", s.gw.base))
            .bearer_auth(&s.gw.token)
            .send()
            .await?;
    assert_eq!(head.status(), 200);
    assert_eq!(head.headers()["content-length"], expected.len().to_string());
    assert!(head.bytes().await?.is_empty());
    let (status, bytes) = s.gw.download(&format!("/message-files/{id}")).await?;
    assert_eq!(status, 200);
    assert_eq!(bytes.as_slice(), expected);
    assert_eq!(file["size_bytes"], expected.len());
    Ok(())
}
