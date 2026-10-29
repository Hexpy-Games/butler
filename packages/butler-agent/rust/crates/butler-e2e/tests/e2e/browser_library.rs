//! S6: persistent Library, Script15 KO/EN/JA search and one idle-write observation.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
mod agent;
mod assets;
pub(super) mod blocks;
mod migration;
mod organize;
mod pages;
use super::idle_resources::writes as idle_disk;
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
fn scrap(id: &str, title: &str) -> Value {
    json!({"id":id,"kind":"scrap","title":title,"url":"https://example.com/","site":"example.com","text":title,"crop":"data:image/jpeg;base64,YQ==","capturedAt":"2026-10-09T00:00:00Z"})
}
/// The `data` of a 200 reply.
fn ok(reply: &butler_e2e::e2e::gateway::Reply) -> Value {
    assert_eq!(reply.status, 200, "{}", reply.text);
    reply.data().clone()
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
    assert_eq!(
        page(&s, "/library?kind=bookmark&q=Work").await?["items"]
            .as_array()
            .unwrap()
            .as_slice(),
        &[] as &[Value]
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
    super::update_progress::history::seed(&s.sandbox.data).await?;
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
        "LIBRARY-history complete_items=75 pages=2 elapsed_us={}",
        started.elapsed().as_micros()
    );
    s.finish().await
}
#[tokio::test]
async fn scrap_snapshots_stay_out_of_pages_and_leave_with_their_scrap() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let mut s = Setup::new("BROWSER-LIBRARY-SNAPSHOT")?.start().await?;
    let html = format!(
        "<!doctype html><html><body><div>{}</div></body></html>",
        "clipped part ".repeat(20_000)
    );
    let mut item = scrap("copy", "Clipped card");
    item["snapshot"] = json!({"html": html, "width": 320.5, "height": 140});
    let reply = s.gw.post("/library", item.clone()).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let listed = page(&s, "/library?kind=scrap").await?;
    assert_eq!(
        listed["items"][0]["snapshot"],
        json!({"width": 320.5, "height": 140})
    );
    assert!(listed.to_string().len() < 4096, "pages carry no HTML copy");
    s.agent.terminate().await?;
    s.gw = s.agent.start_again().await?;
    assert_eq!(
        page(&s, "/library/copy/snapshot").await?["html"],
        json!(html)
    );
    // A size without a document keeps the stored copy; a scrap without a size drops it.
    item["snapshot"] = json!({"width": 320.5, "height": 140});
    assert_eq!(s.gw.post("/library", item.clone()).await?.status, 200);
    assert_eq!(
        page(&s, "/library/copy/snapshot").await?["html"],
        json!(html)
    );
    for bad in [
        json!({"html": "<script>alert(1)</script>", "width": 10, "height": 10}),
        json!({"html": format!("<!doctype html>{}", "x".repeat(6 * 1024 * 1024)), "width": 10, "height": 10}),
        json!({"html": "<!doctype html>", "width": 0, "height": 10}),
    ] {
        item["snapshot"] = bad;
        assert_eq!(s.gw.post("/library", item.clone()).await?.status, 400);
    }
    assert_eq!(
        page(&s, "/library/copy/snapshot").await?["html"],
        json!(html)
    );
    assert_eq!(s.gw.delete("/library/copy").await?.status, 200);
    assert_eq!(
        page(&s, "/library/copy/snapshot").await?["html"],
        Value::Null
    );
    let mut plain = scrap("plain", "Image only");
    plain["snapshot"] = Value::Null;
    assert_eq!(s.gw.post("/library", plain).await?.status, 200);
    assert_eq!(
        page(&s, "/library/plain/snapshot").await?["html"],
        Value::Null
    );
    s.finish().await
}

#[tokio::test]
async fn crop_scraps_allow_no_source_and_reject_invalid_sources() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("LIBRARY-CROP-SOURCE")?.start().await?;
    let mut item = scrap("crop", "Picture without a source page");
    item["url"] = json!("");
    ok(&s.gw.post("/library", item.clone()).await?);
    let listed = page(&s, "/library?kind=scrap").await?;
    assert_eq!(listed["items"].as_array().unwrap().len(), 1);
    assert_eq!(listed["items"][0]["url"], "");
    assert_eq!(listed["items"][0]["crop"], item["crop"]);
    for url in [
        "file:///x",
        "javascript:alert(1)",
        "data:text/html,x",
        " ",
        "https://user:pass@example.com/",
    ] {
        item["url"] = json!(url);
        let rejected = s.gw.post("/library", item.clone()).await?;
        assert_eq!(rejected.status, 400, "{}", rejected.text);
        assert_eq!(rejected.error_code(), Some("invalid_library_item"));
    }
    assert_eq!(page(&s, "/library?kind=scrap").await?, listed);
    s.finish().await
}
