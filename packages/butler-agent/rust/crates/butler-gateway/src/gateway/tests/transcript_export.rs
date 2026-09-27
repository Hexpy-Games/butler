use super::*;

use std::sync::atomic::{AtomicU64, Ordering};

use super::artifact_session::{open_app, start_real};

static NEXT_DB: AtomicU64 = AtomicU64::new(1);

#[tokio::test]
async fn transcript_export_streams_every_visible_message_across_pages() {
    let path = std::env::temp_dir().join(format!(
        "butler-transcript-export-{}-{}.sqlite",
        std::process::id(),
        NEXT_DB.fetch_add(1, Ordering::Relaxed)
    ));
    let application = Arc::new(open_app(&path).await);
    let roles = ["user", "assistant", "automation", "system_event"];
    let mut rows = Vec::new();
    let mut expected =
        String::from("# Transcript/A\n\nSession: chat\nGenerated: 2026-09-14T00:00:00.000Z\n\n");
    for index in 0..203 {
        if index == 100 {
            rows.push(("system".into(), "private system row".into(), None));
            rows.push((
                "assistant".into(),
                "hidden legacy failure".into(),
                Some("app_turn_queue_failed".into()),
            ));
        }
        let role = roles[index % roles.len()];
        let text = if index == 202 {
            "tail \"quoted\" \\ line\n한글".to_owned()
        } else {
            format!("message-{index:03}")
        };
        rows.push((role.into(), text.clone(), None));
        expected.push_str(&format!("## {role}\n\n{text}\n\n"));
    }
    crate::gateway::application::seed_test_transcript_messages(
        &application,
        "general",
        "Transcript/A",
        rows,
    )
    .await
    .unwrap();

    let server = start_real(application.clone()).await;
    let response = request(
        server.local_addr(),
        "GET /transcript-export?sessionId=general HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n",
    )
    .await;
    assert!(response.starts_with("HTTP/1.1 200 OK"), "{response}");
    assert!(response.contains("content-type: application/json; charset=utf-8"));
    assert!(response.contains("cache-control: no-store"));
    let value: Value = serde_json::from_str(&decoded_body(&response)).unwrap();
    assert_eq!(value["protocol_version"], "butler.app.v1");
    assert_eq!(value["data"]["session_id"], "general");
    assert_eq!(value["data"]["format"], "markdown");
    assert_eq!(value["data"]["filename"], "Transcript-A.md");
    assert_eq!(value["data"]["generated_at"], "2026-09-14T00:00:00.000Z");
    assert_eq!(value["data"]["message_count"], 203);
    assert_eq!(value["data"]["content"], expected);

    server.close().await.unwrap();
    application.close().await.unwrap();
    let _ = std::fs::remove_file(path);
}

pub(super) fn empty_export(session_id: String) -> ApplicationFuture<TranscriptExport> {
    Box::pin(async move {
        let (_sender, chunks) = tokio::sync::mpsc::channel(1);
        Ok(TranscriptExport {
            session_id,
            format: "markdown".into(),
            filename: "session.md".into(),
            generated_at: "2026-09-14T00:00:00.000Z".into(),
            chunks,
        })
    })
}

fn decoded_body(response: &str) -> String {
    let (headers, body) = response.split_once("\r\n\r\n").unwrap();
    if !headers
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        return body.to_owned();
    }
    let bytes = body.as_bytes();
    let mut cursor = 0;
    let mut decoded = Vec::new();
    loop {
        let line_end = bytes[cursor..]
            .windows(2)
            .position(|window| window == b"\r\n")
            .map(|offset| cursor + offset)
            .unwrap();
        let length =
            usize::from_str_radix(std::str::from_utf8(&bytes[cursor..line_end]).unwrap(), 16)
                .unwrap();
        cursor = line_end + 2;
        if length == 0 {
            break;
        }
        decoded.extend_from_slice(&bytes[cursor..cursor + length]);
        cursor += length + 2;
    }
    String::from_utf8(decoded).unwrap()
}
