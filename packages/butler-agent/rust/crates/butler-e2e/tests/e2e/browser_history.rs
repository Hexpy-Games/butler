//! Browser history through the authenticated App boundary (stub, no model/network).
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]
mod agent;
mod commands;
mod scale;
use butler_e2e::e2e::{HarnessError, scenario::Setup, security::AdminClient};
use reqwest::Method;
use serde_json::{Value, json};

fn visit(url: &str, time: &str, title: &str) -> Value {
    json!({"url":url,"title":title,"favicon":"https://example.com/icon.png","visitedAt":time,"transition":"link","tabKind":"mine","butlerDriven":false,"source":"butler"})
}
async fn items(s: &butler_e2e::e2e::scenario::Scenario, path: &str) -> Result<Value, HarnessError> {
    let reply = s.gw.get(path).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(reply.data().clone())
}
#[tokio::test]
async fn browser_history_records_searches_dedupes_and_deletes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-HISTORY")?.start().await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let a = visit(
        "https://example.com/recipe",
        "2026-10-10T01:00:00Z",
        "CAFÉ recipe",
    );
    let mut b = visit(
        "https://example.com/ko",
        "2026-10-11T01:00:00Z",
        "청자 전시회",
    );
    b["tabKind"] = json!("conversation");
    b["conversationId"] = json!("general");
    b["butlerDriven"] = json!(true);
    let mut hidden = b.clone();
    hidden["conversationId"] = json!("hidden-child");
    let mut private = a.clone();
    private["private"] = json!(true);
    let mut background = a.clone();
    background["background"] = json!(true);
    b["background"] = json!(true);
    let mut visits = vec![a.clone(), a, b.clone(), hidden, private, background];
    for url in [
        "data:text/html,a",
        "about:blank",
        "blob:https://example.com/abc",
        "http://127.0.0.1:1/__p/test",
        "http://127.0.0.1:1/__o/test",
    ] {
        visits.push(visit(url, "2026-10-11T01:00:00Z", "Excluded"));
    }
    let saved = admin
        .send(
            Method::POST,
            "/internal/browser-host/visits",
            Some(json!({"visits":visits})),
            &[],
        )
        .await?;
    assert_eq!(saved.status, 200, "{}", saved.text);
    assert_eq!(
        items(&s, "/browser-history").await?["items"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    for (query, title) in [
        ("cafe", "CAFÉ recipe"),
        ("rec", "CAFÉ recipe"),
        ("청자", "청자 전시회"),
    ] {
        let found = items(&s, &format!("/browser-history?q={query}")).await?;
        assert_eq!(found["items"][0]["title"], title);
        assert_eq!(found["items"].as_array().unwrap().len(), 1);
    }
    let driven = items(&s, "/browser-history?butlerOnly=true").await?;
    assert_eq!(driven["items"].as_array().unwrap().len(), 1);
    assert_eq!(driven["items"][0]["conversationId"], "general");
    let id = driven["items"][0]["id"].as_i64().unwrap();
    assert_eq!(
        s.gw.post("/browser-history/delete", json!({"ids":[id]}))
            .await?
            .status,
        200
    );
    b["metadataOnly"] = json!(true);
    assert_eq!(
        admin
            .send(
                Method::POST,
                "/internal/browser-host/visits",
                Some(json!({"visits":[b]})),
                &[]
            )
            .await?
            .status,
        200
    );
    let empty: &[Value] = &[];
    assert_eq!(
        items(&s, "/browser-history?q=청자").await?["items"]
            .as_array()
            .unwrap()
            .as_slice(),
        empty
    );
    assert_eq!(
        items(&s, "/browser-history/suggestions?q=청자").await?["items"]
            .as_array()
            .unwrap()
            .as_slice(),
        empty
    );
    assert_eq!(
        s.gw.post(
            "/browser-history/clear",
            json!({"range":"all","butlerOnly":false})
        )
        .await?
        .status,
        200
    );
    assert_eq!(
        items(&s, "/browser-history").await?["items"]
            .as_array()
            .unwrap()
            .as_slice(),
        empty
    );
    s.finish().await
}
