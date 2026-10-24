//! AT flows exercise the authenticated canon upload, event relay and file store.
use super::*;
use butler_e2e::e2e::media;
use std::fmt::Write as _;

pub(super) async fn upload(s: &Scenario, project: &str) -> Result<Value, HarnessError> {
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
pub(super) async fn save(
    s: &Scenario,
    project: &str,
    description: &str,
) -> Result<Value, HarnessError> {
    let stream = LiveEvents::subscribe(&s.gw, 0).await?;
    let epic = data(
        s.gw.post(
            &format!("/projects/{project}/canon/epics"),
            json!({"title":"Attachment","description":description}),
        )
        .await?,
        201,
    );
    let ids = butler_canon::store::attachment_references(description).unwrap();
    assert_eq!(
        epic["attachments"].as_array().unwrap().len(),
        ids.len(),
        "create response precedes relay installation"
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
    assert_eq!(oversized.body["error"]["code"], "file_too_large");
    let boundary =
        s.gw.upload_file(
            &path,
            "limit.txt",
            "text/plain",
            &vec![b'x'; 10 * 1024 * 1024],
        )
        .await?;
    assert_eq!(boundary.status, 201, "{}", boundary.text);
    let mut references = String::new();
    for n in 0..21 {
        write!(
            references,
            "[file](attachment:file-00000000-0000-0000-0000-{n:012})"
        )
        .unwrap();
    }
    let overflow =
        s.gw.post(
            &format!("/projects/{project}/canon/epics"),
            json!({"title":"Too many","description":references}),
        )
        .await?;
    assert_eq!(overflow.status, 409);
    assert_eq!(overflow.body["error"]["code"], "too_many_attachments");
    s.finish().await
}
pub(super) mod requires_e2e_fixtures {
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
    pub(in super::super) async fn jump(address: String, now: &'static str) -> Result<(), HarnessError> {
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

#[tokio::test]
async fn at_07_chat_delete_sweeps_only_unreferenced_files() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("AT-07")?.start().await?;
    let project = project(&s).await?;
    let chat = data(s.gw.post("/sessions", json!({"kind":"chat"})).await?, 201);
    let chat = chat["session"]["id"].as_str().unwrap();
    let mut files = Vec::new();
    for _ in 0..2 {
        files.push(
            data(
                s.gw.upload("note.txt", "text/plain", b"Notes", Some(chat))
                    .await?,
                201,
            )["file"]
                .clone(),
        );
    }
    let epic = save(
        &s,
        &project,
        &format!(
            "[notes](attachment:{})",
            files[1]["file_id"].as_str().unwrap()
        ),
    )
    .await?;
    let deleted =
        s.gw.delete(&format!("/sessions/{chat}?permanent=true"))
            .await?;
    assert_eq!(deleted.status, 200, "{}", deleted.text);
    assert_eq!(
        s.gw.get(files[0]["url"].as_str().unwrap()).await?.status,
        404
    );
    assert!(
        !s.sandbox
            .data
            .join("app-server/message-files")
            .join(files[0]["file_id"].as_str().unwrap())
            .exists()
    );
    assert_eq!(
        s.gw.download(files[1]["url"].as_str().unwrap()).await?.1,
        b"Notes"
    );
    let loaded = data(
        s.gw.get(&format!("/canon/epics/{}", epic["id"].as_str().unwrap()))
            .await?,
        200,
    );
    assert_eq!(loaded["attachments"][0]["file_id"], files[1]["file_id"]);
    s.finish().await
}

#[tokio::test]
async fn at_09_historical_references_do_not_block_label_or_tag_events() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let mut s = Setup::new("AT-09")?.start().await?;
    let project = project(&s).await?;
    let epic = create_epic(&s, &project, "Historical").await?;
    let tag = data(
        s.gw.post(
            &format!("/projects/{project}/canon/tags"),
            json!({"name":"Notes","color":"blue"}),
        )
        .await?,
        201,
    );
    s.agent.terminate().await?;
    let mut description = "[old](attachment:invalid)".to_owned();
    for n in 0..21 {
        write!(
            description,
            "[file](attachment:file-00000000-0000-4000-8000-{n:012})"
        )
        .unwrap();
    }
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    db.execute(
        "UPDATE canon_epics SET description=?1 WHERE id=?2",
        rusqlite::params![description, epic["id"].as_str()],
    )?;
    drop(db);
    s.restart().await?;
    let stream = LiveEvents::subscribe(&s.gw, 0).await?;
    let changed = data(
        s.gw.patch(
            &format!("/canon/epics/{}", epic["id"].as_str().unwrap()),
            json!({"expected_revision":epic["revision"],"status":"in_progress","tags":[tag["id"]]}),
        )
        .await?,
        200,
    );
    assert_eq!(changed["description"], description);
    assert_eq!(changed["attachments"], json!([]));
    let relayed = stream
        .wait_for(Duration::from_secs(10), |event| {
            event["type"] == "canon.changed"
                && event["payload"]["id"] == epic["id"]
                && event["payload"]["revision"] == changed["revision"]
        })
        .await?;
    assert_eq!(
        relayed["payload"]["attachments"].as_array().unwrap().len(),
        22
    );
    let loaded = data(
        s.gw.get(&format!("/canon/epics/{}", epic["id"].as_str().unwrap()))
            .await?,
        200,
    );
    assert_eq!(loaded["description"], description);
    assert_eq!(loaded["canon_status"], "in_progress");
    assert_eq!(loaded["tags"][0]["id"], tag["id"]);
    s.finish().await
}
