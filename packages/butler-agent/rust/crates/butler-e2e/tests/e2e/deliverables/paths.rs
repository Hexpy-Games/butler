//! Paths retain file identity independently of delivery titles.
use super::*;

#[tokio::test]
async fn external_working_file_stays_readable_without_a_drawer_item() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("DELIVERABLE-EXTERNAL")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
    let outside = setup.sandbox.home.join("outside.md");
    *script.steps.lock().unwrap() =
        [write(outside.to_str().unwrap(), "Working bytes"), done()].into();
    let s = setup.start().await?;
    *script.prompt.lock().unwrap() = "Write an external working file.".into();
    let accepted =
        s.gw.send_message(json!({"chat_id":"general",
        "text":"Write an external working file.","access_mode":"full_access",
        "client_message_id":uuid::Uuid::new_v4().to_string()}))
            .await?;
    let turn = s.gw.accepted_turn(&accepted).await?;
    s.gw.wait_terminal(
        "general",
        &turn,
        std::time::Duration::from_secs(butler_e2e::e2e::scenario::turn_timeout()),
    )
    .await?;
    let message = last(&s).await?;
    let files = message["attachments"].as_array().unwrap();
    assert_eq!(files.len(), 1, "{message}");
    assert_eq!(files[0]["deliverable"], false);
    assert!(files[0]["source_label"].is_null());
    assert_eq!(
        s.gw.get(files[0]["url"].as_str().unwrap()).await?.text,
        "Working bytes"
    );
    assert_eq!(documents(&s).await?, Vec::<Value>::new());
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn delivery_accepts_backslashes_and_raw_absolute_workspace_paths() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("DELIVERABLE-PATHS")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
    let absolute = setup.sandbox.data.join("report.md");
    *script.steps.lock().unwrap() = [
        write("nested/table.csv", "a,b"),
        write("report.md", "Report bytes"),
        deliver("nested\\table.csv", "Table"),
        deliver(absolute.to_str().unwrap(), "Report"),
        done(),
    ]
    .into();
    let s = setup.start().await?;
    run_turn(&s, &script, "Deliver both files.").await?;
    let docs = documents(&s).await?;
    assert_eq!(docs.len(), 2, "{docs:?}");
    assert!(docs.iter().any(|d| d["source"] == "nested/table.csv"));
    assert!(docs.iter().any(|d| d["source"] == "report.md"));
    s.finish().await?;
    server.abort();
    Ok(())
}
