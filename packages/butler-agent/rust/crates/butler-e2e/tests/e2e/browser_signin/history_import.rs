//! Generated DBs exercise the existing detected-profile import, not real profiles.
use super::host::admin;
use butler_e2e::e2e::{HarnessError, scenario::Setup, security::AdminClient};
use butler_platform::browser_profiles::profile_roots;
use reqwest::Method;
use serde_json::{Value, json};

async fn post(a: &AdminClient, op: &str, body: Value) -> Result<Value, HarnessError> {
    let reply = a
        .send(
            Method::POST,
            &format!("/security/browser-import/{op}"),
            Some(body),
            &[],
        )
        .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(reply.data().clone())
}
fn fixture(path: &std::path::Path, format: &str, count: i64, now: i64) -> rusqlite::Connection {
    let db = rusqlite::Connection::open(path).unwrap();
    let (schema, insert_url, insert_visit, epoch, units) = match format {
        "chrome" => (
            "CREATE TABLE urls(id INTEGER PRIMARY KEY,url TEXT,title TEXT); CREATE TABLE visits(id INTEGER PRIMARY KEY,url INTEGER,visit_time INTEGER);",
            "INSERT INTO urls VALUES(?1,?2,'Imported')",
            "INSERT INTO visits VALUES(?1,?1,?2)",
            11_644_473_600_000_i64,
            1000.0,
        ),
        "firefox" => (
            "CREATE TABLE moz_places(id INTEGER PRIMARY KEY,url TEXT,title TEXT); CREATE TABLE moz_historyvisits(id INTEGER PRIMARY KEY,place_id INTEGER,visit_date INTEGER);",
            "INSERT INTO moz_places VALUES(?1,?2,'Imported')",
            "INSERT INTO moz_historyvisits VALUES(?1,?1,?2)",
            0,
            1000.0,
        ),
        _ => (
            "CREATE TABLE history_items(id INTEGER PRIMARY KEY,url TEXT); CREATE TABLE history_visits(id INTEGER PRIMARY KEY,history_item INTEGER,visit_time REAL,title TEXT);",
            "INSERT INTO history_items VALUES(?1,?2)",
            "INSERT INTO history_visits VALUES(?1,?1,?2,'Imported')",
            -978_307_240,
            0.001,
        ),
    };
    db.execute_batch(&format!("PRAGMA journal_mode=WAL; {schema} BEGIN"))
        .unwrap();
    {
        let mut urls = db.prepare(insert_url).unwrap();
        let mut visits = db.prepare(insert_visit).unwrap();
        for id in 1..=count + 3 {
            let url = match id - count {
                1 => "about:blank".to_owned(),
                2 => "chrome://settings/".to_owned(),
                _ => format!("https://history.fixture.test/{id}"),
            };
            let time = if id == count + 3 {
                now - 181 * 86_400_000
            } else {
                now - count + id
            };
            urls.execute(rusqlite::params![id, url]).unwrap();
            visits
                .execute(rusqlite::params![id, (time + epoch) as f64 * units])
                .unwrap();
        }
    }
    db.execute_batch("COMMIT").unwrap();
    db
}
#[tokio::test]
async fn history_import_formats_dedupe_native_visits_and_undo() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("BROWSER-HISTORY-IMPORT")?;
    let roots = profile_roots(&setup.sandbox.home);
    let chrome = roots
        .chromium
        .iter()
        .find(|(b, _)| *b == "chrome")
        .unwrap()
        .1
        .join("Default");
    std::fs::create_dir_all(&chrome)?;
    std::fs::write(
        chrome.parent().unwrap().join("Local State"),
        br#"{"profile":{"info_cache":{"Default":{"name":"Fixture"}}}}"#,
    )?;
    let firefox = roots.firefox.join("fixture");
    std::fs::create_dir_all(&firefox)?;
    let base = if roots.firefox.file_name().is_some_and(|n| n == "Profiles") {
        roots.firefox.parent().unwrap()
    } else {
        &roots.firefox
    };
    std::fs::write(
        base.join("profiles.ini"),
        format!(
            "[Profile0]\nName=Fixture\nPath={}\nIsRelative=1\n",
            firefox.strip_prefix(base).unwrap().display()
        ),
    )?;
    let now = chrono::Utc::now().timestamp_millis() - 1000;
    let mut dbs = vec![
        fixture(&chrome.join("History"), "chrome", 3, now),
        fixture(&firefox.join("places.sqlite"), "firefox", 3, now),
    ];
    let mut sources = vec!["chrome:Default", "firefox:fixture"];
    if let Some(bookmarks) = roots.safari {
        std::fs::create_dir_all(bookmarks.parent().unwrap())?;
        std::fs::write(&bookmarks, b"fixture")?;
        dbs.push(fixture(
            &bookmarks.parent().unwrap().join("History.db"),
            "safari",
            3,
            now,
        ));
        sources.push("safari:default");
    }
    let s = setup.start().await?;
    let a = admin(&s);
    let time = chrono::DateTime::from_timestamp_millis(now - 2)
        .unwrap()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let native = a.send(Method::POST,"/internal/browser-host/visits",Some(json!({"visits":[{"url":"https://history.fixture.test/1","title":"Native","visitedAt":time,"tabKind":"mine"}]})),&[]).await?;
    assert_eq!(native.status, 200);
    for source in sources {
        let request = json!({"source":source,"bookmarks":false,"passwords":false,"history":true});
        let first = post(&a, "start", request.clone()).await?;
        assert_eq!(first["history"], 2);
        let page = s.gw.get("/browser-history").await?;
        assert_eq!(page.data()["items"].as_array().unwrap().len(), 3);
        assert_eq!(
            page.data()["items"][0]["url"],
            "https://history.fixture.test/3"
        );
        let suggestions = s.gw.get("/browser-history/suggestions?q=Imported").await?;
        assert_eq!(suggestions.data()["items"].as_array().unwrap().len(), 2);
        let again = post(&a, "start", request).await?;
        assert_eq!(again["history"], 0);
        assert_eq!(
            post(&a, "undo", json!({"run_id":again["run_id"]})).await?["history"],
            0
        );
        assert_eq!(
            post(&a, "undo", json!({"run_id":first["run_id"]})).await?["history"],
            2
        );
        assert_eq!(
            s.gw.get("/browser-history").await?.data()["items"][0]["source"],
            "butler"
        );
    }
    drop(dbs);
    s.finish().await
}
#[tokio::test]
async fn history_import_paged_complete_and_ordered() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("BROWSER-HISTORY-IMPORT-SCALE")?;
    let root = profile_roots(&setup.sandbox.home)
        .chromium
        .into_iter()
        .find(|(b, _)| *b == "chrome")
        .unwrap()
        .1
        .join("Default");
    std::fs::create_dir_all(&root)?;
    std::fs::write(
        root.parent().unwrap().join("Local State"),
        br#"{"profile":{"info_cache":{"Default":{"name":"Fixture"}}}}"#,
    )?;
    let now = chrono::Utc::now().timestamp_millis() - 1000;
    drop(fixture(&root.join("History"), "chrome", 240, now));
    let s = setup.start().await?;
    let started = std::time::Instant::now();
    let first = post(
        &admin(&s),
        "start",
        json!({"source":"chrome:Default","history":true,"bookmarks":false,"passwords":false}),
    )
    .await?;
    assert_eq!(first["history"], 240);
    let elapsed = started.elapsed().as_millis();
    let db =
        rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite")).unwrap();
    let mut query = db
        .prepare("SELECT url,visited_at,title,tab_kind,source FROM browser_history ORDER BY visited_at,id")
        .unwrap();
    let rows = query
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            ))
        })
        .unwrap();
    let mut count = 0;
    for row in rows {
        count += 1;
        let (url, time, title, kind, source) = row.unwrap();
        assert_eq!(url, format!("https://history.fixture.test/{count}"));
        assert_eq!(time, now - 240 + count);
        assert_eq!(title, "Imported");
        assert_eq!(kind, "mine");
        assert_eq!(
            source,
            format!("imported:{}", first["run_id"].as_str().unwrap())
        );
    }
    assert_eq!(count, 240);
    let summary: i64 = db
        .query_row("SELECT sum(visits) FROM browser_history_url", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(summary, 240);
    for table in [
        "browser_history_url",
        "browser_history_visit_fts",
        "browser_history_fts",
    ] {
        let indexed: i64 = db
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap();
        assert_eq!(indexed, 240, "{table}");
    }
    eprintln!("HISTORY-IMPORT visits={count} elapsed_ms={elapsed} complete_order=true");
    drop(query);
    drop(db);
    s.finish().await
}
