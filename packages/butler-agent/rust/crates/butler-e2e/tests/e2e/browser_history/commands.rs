//! Range clearing, complete keyset pages, recency × frequency and import merging.
use super::{items, visit};
use butler_e2e::e2e::{HarnessError, scenario::Setup, security::AdminClient};
use chrono::{Duration, Utc};
use reqwest::Method;
use serde_json::{Value, json};
fn at(hours: i64) -> String {
    (Utc::now() - Duration::hours(hours)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
#[tokio::test]
async fn browser_history_clear_ranges_and_suggestion_frecency() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-HISTORY-COMMANDS")?.start().await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let mut rows = Vec::new();
    for (id, hours) in [("now", 0), ("recent", 2), ("old", 200)] {
        rows.push(visit(
            &format!("https://example.com/{id}"),
            &at(hours),
            "Recipe",
        ));
    }
    for n in 0..4 {
        rows.push(visit(
            "https://example.com/popular",
            &(Utc::now() - Duration::minutes(n + 2)).to_rfc3339(),
            "Recipe popular",
        ));
    }
    let mut driven = visit("https://example.com/agent", &at(0), "Recipe Butler");
    driven["butlerDriven"] = json!(true);
    rows.push(driven);
    let mut imported = rows[0].clone();
    imported["source"] = json!("imported:chrome");
    rows.push(imported);
    assert_eq!(
        admin
            .send(
                Method::POST,
                "/internal/browser-host/visits",
                Some(json!({"visits":rows})),
                &[]
            )
            .await?
            .status,
        200
    );
    assert_eq!(
        items(&s, "/browser-history").await?["items"]
            .as_array()
            .unwrap()
            .len(),
        8
    );
    assert_eq!(s.gw.post("/library",json!({"id":"b","kind":"bookmark","url":"https://bookmark.example/recipe","title":"Recipe bookmark","capturedAt":at(0)})).await?.status,200);
    let suggestions = items(&s, "/browser-history/suggestions?q=rec").await?;
    assert_eq!(
        suggestions["items"][0]["url"],
        "https://example.com/popular"
    );
    assert_eq!(suggestions["items"][0]["visits"], 4);
    assert!(
        suggestions["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["bookmarkId"].is_string())
    );
    for pair in suggestions["items"].as_array().unwrap().windows(2) {
        assert!(pair[0]["score"].as_f64().unwrap() >= pair[1]["score"].as_f64().unwrap());
    }
    let result =
        s.gw.post(
            "/browser-history/clear",
            json!({"range":"hour","butlerOnly":true}),
        )
        .await?;
    assert_eq!(result.status, 200);
    assert_eq!(result.data()["deleted"], 1);
    assert_eq!(
        s.gw.post("/browser-history/clear", json!({"range":"hour"}))
            .await?
            .data()["deleted"],
        5
    );
    let left = items(&s, "/browser-history").await?;
    assert_eq!(left["items"].as_array().unwrap().len(), 2);
    assert_eq!(
        s.gw.post("/browser-history/clear", json!({"range":"week"}))
            .await?
            .data()["deleted"],
        1
    );
    assert_eq!(
        items(&s, "/browser-history").await?["items"][0]["url"],
        "https://example.com/old"
    );
    // The E2E process deliberately runs in UTC.
    let midnight = Utc::now()
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc();
    let today = visit("https://example.com/today", &midnight.to_rfc3339(), "Today");
    assert_eq!(
        admin
            .send(
                Method::POST,
                "/internal/browser-host/visits",
                Some(json!({"visits":[today]})),
                &[]
            )
            .await?
            .status,
        200
    );
    assert_eq!(
        s.gw.post("/browser-history/clear", json!({"range":"today"}))
            .await?
            .data()["deleted"],
        1
    );
    assert_eq!(
        s.gw.post("/browser-history/clear", json!({"range":"all"}))
            .await?
            .data()["deleted"],
        1
    );
    assert_eq!(
        items(&s, "/browser-history/suggestions?q=rec").await?["items"]
            .as_array()
            .unwrap()
            .len(),
        1,
        "only the bookmark remains"
    );
    s.finish().await
}
#[tokio::test]
async fn browser_history_pages_are_durable_complete_and_idle_has_no_writes()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("BROWSER-HISTORY-PAGES")?
        .env("BUTLER_E2E_IDLE_PROBE", "1")
        .start()
        .await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let rows: Vec<Value> = (0..75)
        .map(|n| {
            visit(
                &format!("https://example.com/{n:03}"),
                &at(n),
                "図書館の予約",
            )
        })
        .collect();
    assert_eq!(
        admin
            .send(
                Method::POST,
                "/internal/browser-host/visits",
                Some(json!({"visits":rows})),
                &[]
            )
            .await?
            .status,
        200
    );
    s.agent.terminate().await?;
    s.gw = s.agent.start_again().await?;
    let started = std::time::Instant::now();
    let first = items(&s, "/browser-history?q=図書館").await?;
    let cursor = first["next_cursor"].as_str().unwrap();
    let mut path = reqwest::Url::parse("http://fixture/browser-history").unwrap();
    path.query_pairs_mut()
        .append_pair("q", "図書館")
        .append_pair("cursor", cursor);
    let second = items(&s, &format!("{}?{}", path.path(), path.query().unwrap())).await?;
    let all: Vec<_> = first["items"]
        .as_array()
        .unwrap()
        .iter()
        .chain(second["items"].as_array().unwrap())
        .collect();
    assert_eq!(all.len(), 75);
    assert!(second["next_cursor"].is_null());
    for (n, item) in all.iter().enumerate() {
        assert_eq!(item["url"], format!("https://example.com/{n:03}"));
    }
    eprintln!(
        "HISTORY-PAGES complete_items=75 pages=2 elapsed_us={}",
        started.elapsed().as_micros()
    );
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    let mut watch = super::super::idle_resources::writes::Watch::open(&s.sandbox.data)?;
    let _page = items(&s, "/browser-history").await?;
    let _suggestions = items(&s, "/browser-history/suggestions?q=図書館").await?;
    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
    watch.assert_unchanged();
    drop(watch);
    s.finish().await
}
