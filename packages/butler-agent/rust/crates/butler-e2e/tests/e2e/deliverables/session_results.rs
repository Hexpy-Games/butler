//! Results expose explicit deliveries; working evidence and user uploads retain their roles.
use super::*;

#[tokio::test]
async fn session_results_keep_latest_delivery_without_working_files() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let mut steps: Vec<_> = (0..8)
        .map(|n| write(&format!("sources/page-{n}.html"), "<h1>Source</h1>"))
        .collect();
    steps.extend([
        write("report.md", "Report"),
        deliver("report.md", "First"),
        done(),
    ]);
    *script.steps.lock().unwrap() = steps.into();
    let s = Setup::new("SESSION-RESULTS")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"))
        .start()
        .await?;
    run_turn(&s, &script, "Research and deliver a report.").await?;
    let first = last(&s).await?;
    assert_eq!(first["attachments"].as_array().unwrap().len(), 9);
    assert_eq!(first["artifacts"].as_array().unwrap().len(), 1);
    assert_eq!(first["artifacts"][0]["source_label"], "report.md");
    for file in first["attachments"].as_array().unwrap() {
        assert_eq!(s.gw.get(file["url"].as_str().unwrap()).await?.status, 200);
    }
    let artifacts = results(&s).await?;
    assert_eq!(artifacts.len(), 1, "{artifacts:?}");
    assert_eq!(artifacts[0]["message_id"], first["id"]);
    assert_eq!(artifacts[0]["sha256"], first["artifacts"][0]["sha256"]);
    *script.steps.lock().unwrap() = [deliver("report.md", "Latest"), done()].into();
    run_turn(&s, &script, "Deliver the same report again.").await?;
    let latest = last(&s).await?;
    let artifacts = results(&s).await?;
    assert_eq!(artifacts.len(), 1, "{artifacts:?}");
    assert_eq!(artifacts[0]["message_id"], latest["id"]);
    assert_eq!(artifacts[0]["created_at"], latest["updated_at"]);
    // Same bytes at another path and changed bytes at the same path are distinct.
    *script.steps.lock().unwrap() = [
        write("other.md", "Report"),
        deliver("other.md", "Other path"),
        write("report.md", "Revised report"),
        deliver("report.md", "Revised"),
        done(),
    ]
    .into();
    run_turn(&s, &script, "Deliver two distinct results.").await?;
    assert_eq!(results(&s).await?.len(), 3);
    assert!(
        s.gw.messages("general")
            .await?
            .iter()
            .filter(|m| m["role"] == "user")
            .all(|m| m["attachments"].as_array().is_none_or(Vec::is_empty))
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

async fn results(s: &Scenario) -> Result<Vec<Value>, HarnessError> {
    let response = s.gw.get("/artifacts?session_id=general").await?;
    assert_eq!(response.status, 200, "{response:?}");
    let artifacts = response.data()["artifacts"].as_array().unwrap().clone();
    assert!(artifacts.iter().all(|a| a["deliverable"] == true));
    Ok(artifacts)
}

#[tokio::test]
async fn user_upload_remains_a_user_message_attachment() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, _script, server) = stub::start().await?;
    let s = Setup::new("SESSION-USER-UPLOAD")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"))
        .start()
        .await?;
    let upload =
        s.gw.upload("notes.txt", "text/plain", b"User notes", Some("general"))
            .await?;
    assert_eq!(upload.status, 201, "{upload:?}");
    let file = &upload.data()["file"];
    let sent = s.gw.post("/messages", json!({"chat_id":"general", "text":"Read my notes.",
        "attachments":[{"file_id":file["file_id"]}], "client_message_id":uuid::Uuid::new_v4().to_string()})).await?;
    assert_eq!(sent.status, 202, "{sent:?}");
    let turn = s.gw.accepted_turn(sent.data()).await?;
    s.gw.wait_terminal("general", &turn, std::time::Duration::from_secs(30))
        .await?;
    let messages = s.gw.messages("general").await?;
    let user = messages.iter().find(|m| m["role"] == "user").unwrap();
    assert_eq!(user["attachments"][0]["file_id"], file["file_id"]);
    assert_eq!(results(&s).await?, Vec::<Value>::new());
    s.finish().await?;
    server.abort();
    Ok(())
}
