//! AT flows exercise the authenticated canon upload, event relay and file store.
use super::*;
use butler_e2e::e2e::media;

async fn upload(s: &Scenario, project: &str) -> Result<Value, HarnessError> {
    Ok(data(
        s.gw.upload_file(
            &format!("/projects/{project}/canon/files"),
            "capture.png",
            "image/png",
            &media::digits_png("57", 12),
        )
        .await?,
        201,
    )["file"]
        .clone())
}
async fn save(s: &Scenario, project: &str, description: &str) -> Result<Value, HarnessError> {
    let stream = LiveEvents::subscribe(&s.gw, 0).await?;
    let epic = data(
        s.gw.post(
            &format!("/projects/{project}/canon/epics"),
            json!({"title":"Attachment","description":description}),
        )
        .await?,
        201,
    );
    event(&stream, "canon.changed", epic["id"].as_str().unwrap()).await?;
    Ok(data(
        s.gw.get(&format!("/canon/epics/{}", epic["id"].as_str().unwrap()))
            .await?,
        200,
    ))
}
#[tokio::test]
async fn at_01_uploaded_screenshot_is_an_epic_attachment() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("AT-01")?.start().await?;
    let project = project(&s).await?;
    let file = upload(&s, &project).await?;
    let description = format!(
        "# Capture\n![capture](attachment:{})",
        file["file_id"].as_str().unwrap()
    );
    let epic = save(&s, &project, &description).await?;
    assert_eq!(epic["description"], description);
    assert_eq!(epic["attachments"].as_array().unwrap().len(), 1);
    assert_eq!(epic["attachments"][0]["file_id"], file["file_id"]);
    let (status, bytes) = s.gw.download(file["url"].as_str().unwrap()).await?;
    assert_eq!(status, 200);
    assert_eq!(bytes, media::digits_png("57", 12));
    s.finish().await
}
#[tokio::test]
async fn at_02_removing_last_reference_sweeps_the_file() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("AT-02")?.start().await?;
    let project = project(&s).await?;
    let file = upload(&s, &project).await?;
    let epic = save(
        &s,
        &project,
        &format!("![](attachment:{})", file["file_id"].as_str().unwrap()),
    )
    .await?;
    // A rejected stale edit must not keep the last reference alive afterward.
    assert_eq!(
        s.gw.patch(
            &format!("/canon/epics/{}", epic["id"].as_str().unwrap()),
            json!({"expected_revision":0,"description":epic["description"]}),
        )
        .await?
        .status,
        409
    );
    let stream = LiveEvents::subscribe(&s.gw, 0).await?;
    let edited = data(
        s.gw.patch(
            &format!("/canon/epics/{}", epic["id"].as_str().unwrap()),
            json!({"expected_revision":epic["revision"],"description":"Removed"}),
        )
        .await?,
        200,
    );
    stream
        .wait_for(Duration::from_secs(10), |e| {
            e["type"] == "canon.changed"
                && e["payload"]["id"] == epic["id"]
                && e["payload"]["revision"] == edited["revision"]
        })
        .await?;
    // Cleanup follows the relay transaction without another user action.
    let url = file["url"].as_str().unwrap();
    let path = s
        .sandbox
        .data
        .join("app-server/message-files")
        .join(file["file_id"].as_str().unwrap());
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let status = s.gw.get(url).await?.status;
            if status == 404 && !path.exists() {
                return Ok::<_, HarnessError>(());
            }
            assert!(matches!(status, 200 | 404));
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .map_err(|e| HarnessError(e.to_string()))??;
    s.finish().await
}
#[tokio::test]
async fn at_04_markdown_is_stored_as_inert_text() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("AT-04")?.start().await?;
    let project = project(&s).await?;
    let text = "<script>globalThis.executed=true</script>\n<img src='https://example.com/raw.png'>\n![remote](https://example.com/image.png)";
    let epic = save(&s, &project, text).await?;
    assert_eq!(epic["description"], text);
    assert_eq!(epic["attachments"], json!([]));
    // Render/no-network evidence lives in app-canon-attachments-smoke.ts.
    s.finish().await
}
#[tokio::test]
async fn at_05_upload_and_reference_limits() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("AT-05")?.start().await?;
    let project = project(&s).await?;
    let path = format!("/projects/{project}/canon/files");
    let oversized =
        s.gw.upload_file(
            &path,
            "large.txt",
            "text/plain",
            &vec![b'x'; 11 * 1024 * 1024],
        )
        .await?;
    assert_eq!(oversized.status, 413);
    let boundary =
        s.gw.upload_file(
            &path,
            "limit.txt",
            "text/plain",
            &vec![b'x'; 10 * 1024 * 1024],
        )
        .await?;
    assert_eq!(boundary.status, 201, "{}", boundary.text);
    let references = (0..21)
        .map(|n| format!("[file](attachment:file-00000000-0000-0000-0000-{n:012})"))
        .collect::<String>();
    assert_eq!(
        s.gw.post(
            &format!("/projects/{project}/canon/epics"),
            json!({"title":"Too many","description":references})
        )
        .await?
        .status,
        400
    );
    s.finish().await
}
mod requires_e2e_fixtures {
    use super::*;
    #[tokio::test]
    async fn at_06_cancelled_upload_expires_on_next_upload() -> Result<(), HarnessError> {
        butler_e2e::gate!();
        let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
        let address = listener.local_addr()?.to_string();
        drop(listener);
        let s = Setup::new("AT-06")?
            .env("BUTLER_E2E_APP_NOW", "2026-10-24T10:00:00.000Z")
            .env("BUTLER_E2E_APP_CLOCK_ADDRESS", &address)
            .start()
            .await?;
        let project = project(&s).await?;
        let cancelled = upload(&s, &project).await?;
        let kept = upload(&s, &project).await?;
        save(
            &s,
            &project,
            &format!("![](attachment:{})", kept["file_id"].as_str().unwrap()),
        )
        .await?;
        jump(address, "2026-10-25T10:00:01.000Z").await?;
        // Expiry itself causes no file work; the next canon upload does.
        assert_eq!(
            s.gw.download(cancelled["url"].as_str().unwrap()).await?.0,
            200
        );
        let fresh = upload(&s, &project).await?;
        assert_eq!(
            s.gw.get(cancelled["url"].as_str().unwrap()).await?.status,
            404
        );
        for file in [&fresh, &kept] {
            assert_eq!(s.gw.download(file["url"].as_str().unwrap()).await?.0, 200);
        }
        s.finish().await
    }
    async fn jump(address: String, now: &'static str) -> Result<(), HarnessError> {
        tokio::task::spawn_blocking(move || -> Result<(), HarnessError> {
            use std::io::{BufRead, BufReader, Write};
            let mut stream = std::net::TcpStream::connect(address)?;
            stream.set_read_timeout(Some(Duration::from_secs(5)))?;
            writeln!(stream, "{now}")?;
            let mut reply = String::new();
            BufReader::new(stream).read_line(&mut reply)?;
            assert_eq!(serde_json::from_str::<Value>(&reply)?["now"], now);
            Ok(())
        })
        .await
        .map_err(|e| HarnessError(e.to_string()))?
    }
}
