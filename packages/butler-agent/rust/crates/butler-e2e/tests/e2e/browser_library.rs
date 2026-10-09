//! S6: persistent Library, Script15 KO/EN/JA search and one idle-write observation.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]
use super::idle_resources::writes as idle_disk;
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
fn scrap(id: &str, title: &str) -> Value {
    json!({"id":id,"kind":"scrap","title":title,"url":"https://example.com/","text":title,"crop":"data:image/jpeg;base64,YQ==","capturedAt":"2026-10-09T00:00:00Z"})
}
async fn page(s: &butler_e2e::e2e::scenario::Scenario, path: &str) -> Result<Value, HarnessError> {
    let reply = s.gw.get(path).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(serde_json::from_str::<Value>(&reply.text)?["data"].clone())
}
fn path(q: &str, cursor: &str) -> String {
    let mut url = reqwest::Url::parse("http://fixture/library").unwrap();
    url.query_pairs_mut()
        .append_pair("kind", "scrap")
        .append_pair("q", q)
        .append_pair("cursor", cursor);
    format!("{}?{}", url.path(), url.query().unwrap())
}
#[tokio::test]
async fn library_search_and_bookmark_commands_are_durable_and_idle_is_read_only()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("BROWSER-LIBRARY")?
        .env("BUTLER_E2E_IDLE_PROBE", "1")
        .start()
        .await?;
    for (id, title) in [
        ("ko", "청자 전시회"),
        ("en", "CAFÉ recipe"),
        ("ja", "図書館の予約"),
    ] {
        let reply = s.gw.post("/library", scrap(id, title)).await?;
        assert_eq!(reply.status, 200, "{}", reply.text);
    }
    for (query, id) in [("청자", "ko"), ("cafe", "en"), ("図書館", "ja")] {
        let started = Instant::now();
        let found = page(&s, &path(query, "")).await?;
        assert_eq!(found["items"].as_array().unwrap().len(), 1, "{found}");
        assert_eq!(found["items"][0]["id"], id);
        eprintln!(
            "LIBRARY-SEARCH language={id} items=1 elapsed_us={}",
            started.elapsed().as_micros()
        );
    }
    let mut bookmark = json!({"id":"caller-id","kind":"bookmark","title":"Example docs","url":"https://example.com","capturedAt":"2026-10-09T00:00:00Z"});
    let saved = s.gw.post("/library", bookmark.clone()).await?;
    assert_eq!(saved.status, 200, "{}", saved.text);
    bookmark["folder"] = json!("Work");
    bookmark["title"] = json!("Updated docs");
    assert_eq!(s.gw.post("/library", bookmark).await?.status, 200);
    let stored = page(&s, "/library?kind=bookmark").await?;
    assert_eq!(stored["items"].as_array().unwrap().len(), 1);
    assert_eq!(stored["items"][0]["title"], "Updated docs");
    assert_eq!(stored["items"][0]["folder"], "Work");
    s.agent.terminate().await?;
    s.gw = s.agent.start_again().await?;
    let found = page(&s, "/library?kind=bookmark&q=Work").await?;
    assert_eq!(found["items"].as_array().unwrap().len(), 1);
    let id = found["items"][0]["id"].as_str().unwrap();
    assert_eq!(s.gw.delete(&format!("/library/{id}")).await?.status, 200);
    assert!(
        page(&s, "/library?kind=bookmark&q=Work").await?["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    tokio::time::sleep(Duration::from_secs(2)).await;
    let mut watch = idle_disk::Watch::open(&s.sandbox.data)?;
    for _ in 0..3 {
        assert_eq!(
            page(&s, "/library?kind=scrap").await?["items"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
    }
    tokio::time::sleep(Duration::from_secs(10)).await;
    watch.assert_unchanged();
    drop(watch);
    s.finish().await
}
#[tokio::test]
async fn library_pages_are_complete_in_latest_first_order() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("BROWSER-LIBRARY-PAGES")?.start().await?;
    s.agent.terminate().await?;
    super::update_progress::scale::seed(&s.sandbox.data).await?;
    s.gw = s.agent.start_again().await?;
    for n in 0..75 {
        assert_eq!(
            s.gw.post("/library", scrap(&format!("row-{n:03}"), "Complete corpus"))
                .await?
                .status,
            200
        );
    }
    let started = Instant::now();
    let first = page(&s, "/library?kind=scrap&q=corpus").await?;
    let cursor = first["next_cursor"].as_str().unwrap();
    let second = page(&s, &path("corpus", cursor)).await?;
    let all = first["items"]
        .as_array()
        .unwrap()
        .iter()
        .chain(second["items"].as_array().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(all.len(), 75);
    assert!(second["next_cursor"].is_null());
    for (n, item) in all.iter().enumerate() {
        assert_eq!(item["id"], format!("row-{:03}", 74 - n));
    }
    eprintln!(
        "LIBRARY-OWNER-SCALE complete_items=75 pages=2 elapsed_us={}",
        started.elapsed().as_micros()
    );
    s.finish().await
}
