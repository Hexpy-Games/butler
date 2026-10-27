use super::*;
#[tokio::test]
async fn at_03_chat_screenshot_reaches_epic_and_survives_chat_deletion() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (s, script, server, project, chat) = setup("AT-03", Access::AskAlways).await?;
    let bytes = butler_e2e::e2e::media::digits_png("57", 12);
    let file = data(
        s.gw.upload("capture.png", "image/png", &bytes, Some(&chat))
            .await?,
        201,
    )["file"]
        .clone();
    let mut args = proposal(&project, "화면 오류");
    args["changes"][0]["attachments"] = json!([{"file_id":file["file_id"]}]);
    let id = draft(&s, &script, &chat, args).await?;
    let card = read(&s, &id).await?;
    assert_eq!(
        card["epics"][0]["attachments"][0]["file_id"],
        file["file_id"]
    );
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    let result = accept(&s, &id).await?;
    let epic = epic_id(&result);
    live.wait_for(Duration::from_secs(10), |e| {
        e["type"] == "canon.changed" && e["payload"]["id"] == epic
    })
    .await?;
    data(s.gw.delete(&format!("/sessions/{chat}")).await?, 200);
    let current = data(s.gw.get(&format!("/canon/epics/{epic}")).await?, 200);
    assert_eq!(current["attachments"][0]["file_id"], file["file_id"]);
    assert!(
        current["description"]
            .as_str()
            .unwrap()
            .contains("![capture.png](attachment:")
    );
    let (status, loaded) =
        s.gw.download(current["attachments"][0]["url"].as_str().unwrap())
            .await?;
    assert_eq!(status, 200);
    assert_eq!(loaded, bytes);
    server.abort();
    s.finish().await
}
