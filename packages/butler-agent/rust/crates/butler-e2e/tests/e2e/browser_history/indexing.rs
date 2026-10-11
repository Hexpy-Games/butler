//! Transaction-local term reuse must retain the latest visit and metadata.
use super::{items, visit};
use butler_e2e::e2e::{HarnessError, scenario::Setup, security::AdminClient};
use reqwest::Method;
use serde_json::json;

#[tokio::test]
async fn history_batch_latest_terms_and_metadata_are_preserved() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("HISTORY-BATCH-TERMS")?.start().await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let native = visit(
        "https://example.com/native",
        "2026-10-11T01:00:00Z",
        "Native latest",
    );
    assert_eq!(
        admin
            .send(
                Method::POST,
                "/internal/browser-host/visits",
                Some(json!({"visits":[native]})),
                &[]
            )
            .await?
            .status,
        200
    );
    let older = visit("https://example.com/batch", "2026-10-09T01:00:00Z", "Older");
    let latest = visit(
        "https://example.com/batch",
        "2026-10-10T01:00:00Z",
        "청자 Latest",
    );
    let mut metadata = latest.clone();
    metadata["metadataOnly"] = json!(true);
    metadata["title"] = json!("CAFÉ updated");
    let mut older_metadata = older.clone();
    older_metadata["metadataOnly"] = json!(true);
    older_metadata["title"] = json!("Older metadata");
    let mut imported = visit(
        "https://example.com/native",
        "2026-10-09T01:00:00Z",
        "Old imported",
    );
    imported["source"] = json!("imported:fixture");
    let reply = admin
        .send(
            Method::POST,
            "/internal/browser-host/visits",
            Some(json!({"visits":[older,latest.clone(),metadata,older_metadata,imported,latest]})),
            &[],
        )
        .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert_eq!(reply.data()["recorded"], 3);
    let page = items(&s, "/browser-history").await?;
    assert_eq!(page["items"].as_array().unwrap().len(), 4);
    for (query, title, url) in [
        ("cafe", "CAFÉ updated", "https://example.com/batch"),
        ("Native", "Native latest", "https://example.com/native"),
    ] {
        let suggestions = items(&s, &format!("/browser-history/suggestions?q={query}")).await?;
        assert_eq!(suggestions["items"].as_array().unwrap().len(), 1);
        assert_eq!(suggestions["items"][0]["title"], title);
        assert_eq!(suggestions["items"][0]["url"], url);
        assert_eq!(suggestions["items"][0]["visits"], 2);
    }
    s.finish().await
}
