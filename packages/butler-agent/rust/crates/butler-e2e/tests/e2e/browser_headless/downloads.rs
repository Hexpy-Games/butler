//! Conversation downloads on the headless browser (#745 semantics): the file
//! lands in the workspace under downloads/ and becomes a session output.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use super::support::{REPORT, admin, call, node, open, publish, selected, setup};
use butler_e2e::e2e::HarnessError;
use serde_json::{Value, json};
use std::time::Duration;

#[tokio::test]
async fn headless_downloads_land_in_the_workspace_as_outputs() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(selected(), "BUTLER_E2E_BROWSER_BACKEND=headless not set");
    let s = setup("BROWSER-HEADLESS-DOWNLOADS")?.start().await?;
    let admin = admin(&s);
    let url = publish(&s).await?;
    let opened = open(&admin, "general", &url).await?;
    let tab = opened["tab"].clone();
    let page = call(
        &admin,
        "general",
        "tab.observe",
        &tab,
        json!({"include_image":true}),
    )
    .await?;
    let link = node(&page, "link", "Download report")["ref"].clone();
    let steps = json!([{"action":"click","ref":link}]);
    let prepared = call(
        &admin,
        "general",
        "tab.prepare",
        &tab,
        json!({"observation":page["obs"],"steps":steps}),
    )
    .await?;
    let acted = call(
        &admin,
        "general",
        "tab.act",
        &tab,
        json!({"observation":page["obs"],"steps":steps,"prepared_steps":prepared["steps"]}),
    )
    .await?;
    assert_eq!(acted["steps"][0]["status"], "completed", "{acted}");
    let mut events: Vec<Value> = acted["events"].as_array().cloned().unwrap_or_default();
    for _ in 0..100 {
        if events.iter().any(|e| e["type"] == "download_completed") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        let listed = call(&admin, "general", "tabs.list", &Value::Null, json!({})).await?;
        events.extend(listed["events"].as_array().cloned().unwrap_or_default());
    }
    let done = events
        .iter()
        .find(|e| e["type"] == "download_completed")
        .cloned()
        .unwrap_or_else(|| panic!("{events:?}"));
    assert_eq!(done["path"], "downloads/report.csv", "{done}");
    assert_eq!(done["size_bytes"], REPORT.len(), "{done}");
    let output = done["output_id"].as_str().unwrap();
    let artifacts = s.gw.get("/artifacts?session_id=general").await?;
    assert!(artifacts.text.contains(output), "{}", artifacts.text);
    let view = s.gw.get(done["view"].as_str().unwrap()).await?;
    let bytes = reqwest::get(view.data()["url"].as_str().unwrap())
        .await?
        .bytes()
        .await?;
    assert_eq!(bytes.as_ref(), REPORT.as_bytes());
    s.finish().await
}
