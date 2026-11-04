//! OPEN-ORIGINAL: the latest version of a delivered file opens from its
//! original location, user edits included; an older version, or a missing or
//! linked original, opens as the stored copy, and with no original nothing is revealed.
use super::*;
use std::path::PathBuf;

async fn open(s: &Scenario, file_id: &Value) -> Result<(u16, Value), HarnessError> {
    let reply =
        s.gw.post("/internal/opened-files", json!({"file_id": file_id}))
            .await?;
    Ok((
        reply.status,
        serde_json::from_str(&reply.text).unwrap_or(Value::Null),
    ))
}

fn file_id(docs: &[Value], name: &str) -> Value {
    docs.iter()
        .find(|d| d["file"]["safe_name"] == name)
        .unwrap()["file"]["file_id"]
        .clone()
}

#[tokio::test]
async fn latest_delivery_opens_its_original_and_older_ones_their_copy() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    *script.steps.lock().unwrap() = [
        write("notes.md", "First"),
        write("page.html", "<h1>Page</h1>"),
        deliver("notes.md", "Notes"),
        deliver("page.html", "Page"),
        done(),
    ]
    .into();
    let s = Setup::new("OPEN-ORIGINAL")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"))
        .start()
        .await?;
    run_turn(&s, &script, "Deliver the notes and the page.").await?;
    let docs = documents(&s).await?;
    let first = file_id(&docs, "notes.md");
    let page = file_id(&docs, "page.html");

    // Latest: the original itself; a later user edit still opens there (no content gate).
    let (status, body) = open(&s, &first).await?;
    assert_eq!(
        (status, &body["data"]["open"], &body["data"]["original"]),
        (201, &json!(true), &json!(true)),
        "{body}"
    );
    let original = PathBuf::from(body["data"]["path"].as_str().unwrap());
    assert_eq!(std::fs::read_to_string(&original)?, "First");
    std::fs::write(&original, "Edited by the user")?;
    let (_, body) = open(&s, &first).await?;
    assert_eq!(body["data"]["path"], original.to_str().unwrap(), "{body}");

    // A later delivery of the same source: the first is an older version and opens as its copy.
    *script.steps.lock().unwrap() = [
        write("notes.md", "Second"),
        deliver("notes.md", "Notes"),
        done(),
    ]
    .into();
    run_turn(&s, &script, "Deliver the revised notes.").await?;
    let latest = file_id(&documents(&s).await?, "notes.md");
    let (_, body) = open(&s, &first).await?;
    assert_eq!(body["data"]["original"], false, "{body}");
    assert_eq!(
        std::fs::read_to_string(body["data"]["path"].as_str().unwrap())?,
        "First"
    );
    let (_, body) = open(&s, &latest).await?;
    assert_eq!(body["data"]["path"], original.to_str().unwrap(), "{body}");

    // A link in place of the original, or no original: the stored copy opens.
    if butler_platform::command_sandbox::POSIX_SHELL {
        std::fs::remove_file(&original)?;
        butler_platform::secure_fs::symlink(&original.with_file_name("page.html"), &original)?;
        let (_, body) = open(&s, &latest).await?;
        assert_eq!(
            body["data"]["original"], false,
            "a link is never the original: {body}"
        );
    }
    std::fs::remove_file(&original)?;
    let (_, body) = open(&s, &latest).await?;
    assert_eq!(
        (&body["data"]["open"], &body["data"]["original"]),
        (&json!(true), &json!(false)),
        "{body}"
    );
    assert_eq!(
        std::fs::read_to_string(body["data"]["path"].as_str().unwrap())?,
        "Second"
    );

    // Reveal-only content shows its original, and nothing once that is gone.
    let (status, body) = open(&s, &page).await?;
    assert_eq!(
        (status, &body["data"]["open"], &body["data"]["original"]),
        (201, &json!(false), &json!(true)),
        "{body}"
    );
    std::fs::remove_file(body["data"]["path"].as_str().unwrap())?;
    let (status, body) = open(&s, &page).await?;
    assert_eq!(
        (status, body["error"]["code"].as_str()),
        (404, Some("original_not_found")),
        "{body}"
    );

    // The original's path never reaches the model or the App's file records.
    let requests = serde_json::to_string(&*script.requests.lock().unwrap()).unwrap();
    assert!(!requests.contains("origin_path") && !requests.contains("originPath"));
    let app =
        serde_json::to_string(&(documents(&s).await?, s.gw.messages("general").await?)).unwrap();
    assert!(!app.contains("origin_path") && !app.contains("originPath"));
    s.finish().await?;
    server.abort();
    Ok(())
}
