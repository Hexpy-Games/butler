//! Indexed owner-scale history reads retain full pages and exact search results.
use super::{items, visit};
use butler_e2e::e2e::{HarnessError, scenario::Setup, security::AdminClient};
use reqwest::Method;
use serde_json::json;
fn seed(data: &std::path::Path) {
    let db = butler_platform::sqlite::open(data.join("app-server/butler-client.sqlite")).unwrap();
    db.execute_batch("BEGIN;
        WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<49999)
        INSERT INTO browser_history(url,title,favicon,visited_at,transition,tab_kind,butler_driven,source)
        SELECT 'https://scale.example/'||i,CASE WHEN i%10000=0 THEN 'needle' ELSE 'page' END,'',i,'link','mine',0,'imported:fixture' FROM n;
        INSERT INTO browser_history_visit_fts(rowid,terms) SELECT id,title FROM browser_history;
        INSERT INTO browser_history_url(url,title,favicon,last_visit,visits) SELECT url,title,favicon,visited_at,1 FROM browser_history;
        INSERT INTO browser_history_fts(rowid,terms) SELECT id,title FROM browser_history_url;
        COMMIT;").unwrap();
}
#[tokio::test]
async fn history_owner_scale_indexed_reads_and_live_visit_are_complete() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let mut s = Setup::new("BROWSER-HISTORY-SCALE")?.start().await?;
    s.agent.terminate().await?;
    let data = s.sandbox.data.clone();
    tokio::task::spawn_blocking(move || seed(&data))
        .await
        .unwrap();
    s.gw = s.agent.start_again().await?;
    let started = std::time::Instant::now();
    let page = items(&s, "/browser-history").await?;
    assert_eq!(page["items"].as_array().unwrap().len(), 60);
    for (n, row) in page["items"].as_array().unwrap().iter().enumerate() {
        assert_eq!(row["url"], format!("https://scale.example/{}", 49999 - n));
        assert_eq!(row["source"], "imported:fixture");
    }
    let first_us = started.elapsed().as_micros();
    let search = items(&s, "/browser-history?q=need").await?;
    assert_eq!(search["items"].as_array().unwrap().len(), 5);
    for (n, row) in search["items"].as_array().unwrap().iter().enumerate() {
        assert_eq!(
            row["url"],
            format!("https://scale.example/{}", 40000 - n * 10000)
        );
    }
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let visits = [visit(
        "https://scale.example/0",
        "2026-10-11T01:00:00Z",
        "needle latest",
    )];
    assert_eq!(
        admin
            .send(
                Method::POST,
                "/internal/browser-host/visits",
                Some(json!({"visits":visits})),
                &[]
            )
            .await?
            .status,
        200
    );
    let suggestions = items(&s, "/browser-history/suggestions?q=needle").await?;
    assert_eq!(suggestions["items"].as_array().unwrap().len(), 5);
    assert_eq!(suggestions["items"][0]["url"], "https://scale.example/0");
    assert_eq!(suggestions["items"][0]["visits"], 2);
    eprintln!(
        "HISTORY-SCALE visits=50000 first_page_us={first_us} complete_page=60 exact_search=5 latest_visits=2"
    );
    s.finish().await
}
