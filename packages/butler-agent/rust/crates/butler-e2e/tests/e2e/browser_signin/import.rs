//! Import from other browsers with fake profiles and exports in the scenario's
//! own home: bookmarks with folders from Chromium, Firefox, Safari and an HTML
//! export, de-duplicated on a second import; password CSVs from each browser's
//! format into the keychain-backed store (opt-in), counts only, no canary.
use super::fill::{keychain_opt_in, keychain_scenario};
use super::host::admin;
use butler_e2e::e2e::{HarnessError, scenario::Setup, security::AdminClient};
use butler_platform::browser_profiles::profile_roots;
use reqwest::Method;
use serde_json::{Value, json};
use std::path::Path;

const CANARY: &str = "canary-csv-2d8a41";

async fn post(admin: &AdminClient, path: &str, body: Value) -> Result<Value, HarnessError> {
    let reply = admin
        .send(Method::POST, path, Some(body.clone()), &[])
        .await?;
    assert_eq!(reply.status, 200, "{path} {body}: {}", reply.text);
    Ok(reply.data().clone())
}

fn chromium_profile(root: &Path) -> Result<(), HarnessError> {
    std::fs::create_dir_all(root.join("Default"))?;
    std::fs::write(
        root.join("Local State"),
        r#"{"profile":{"info_cache":{"Default":{"name":"Work"}}}}"#,
    )?;
    std::fs::write(
        root.join("Default/Bookmarks"),
        serde_json::to_vec(&json!({"roots":{
        "bookmark_bar":{"name":"Bookmarks bar","type":"folder","children":[
            {"type":"url","name":"Docs","url":"https://docs.fixture.test/"},
            {"type":"folder","name":"Dev","children":[{"type":"url","name":"Repo","url":"https://code.fixture.test/repo"},
                {"type":"url","name":"Local","url":"chrome://settings"}]}]},
        "other":{"name":"Other bookmarks","type":"folder","children":[{"type":"url","name":"Docs again","url":"https://docs.fixture.test/"}]}}}))?,
    )?;
    Ok(())
}

fn firefox_profile(root: &Path) -> Result<(), HarnessError> {
    let dir = root.join("ab12cd.default-release");
    std::fs::create_dir_all(&dir)?;
    let db = rusqlite::Connection::open(dir.join("places.sqlite")).unwrap();
    db.execute_batch(
        "CREATE TABLE moz_places(id INTEGER PRIMARY KEY,url TEXT);
         CREATE TABLE moz_bookmarks(id INTEGER PRIMARY KEY,type INTEGER,fk INTEGER,parent INTEGER,position INTEGER,title TEXT,guid TEXT);
         INSERT INTO moz_bookmarks VALUES(1,2,NULL,0,0,'','root________'),(2,2,NULL,1,0,'menu','menu________'),
           (3,2,NULL,1,1,'toolbar','toolbar_____'),(4,2,NULL,1,2,'tags','tags________'),(5,2,NULL,3,0,'Reading','f-reading'),
           (6,1,1,5,0,'Paper','b1'),(7,1,2,2,0,'News','b2'),(8,2,NULL,4,0,'tagged','t1'),(9,1,3,8,0,'Tag entry','b3');
         INSERT INTO moz_places VALUES(1,'https://paper.fixture.test/a'),(2,'https://news.fixture.test/'),(3,'https://tag.fixture.test/');",
    )
    .unwrap();
    Ok(())
}

const SAFARI: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Children</key><array>
<dict><key>Children</key><array><dict><key>URIDictionary</key><dict><key>title</key><string>Maps</string></dict>
<key>URLString</key><string>https://maps.fixture.test/</string><key>WebBookmarkType</key><string>WebBookmarkTypeLeaf</string></dict></array>
<key>Title</key><string>BookmarksBar</string><key>WebBookmarkType</key><string>WebBookmarkTypeList</string></dict>
<dict><key>Children</key><array><dict><key>URLString</key><string>https://later.fixture.test/</string><key>WebBookmarkType</key><string>WebBookmarkTypeLeaf</string></dict></array>
<key>Title</key><string>com.apple.ReadingList</string><key>WebBookmarkType</key><string>WebBookmarkTypeList</string></dict>
</array><key>Title</key><string></string><key>WebBookmarkType</key><string>WebBookmarkTypeList</string></dict></plist>"#;

const HTML: &str = r#"<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p><DT><H3>Travel &amp; Food</H3><DL><p><DT><A HREF="https://food.fixture.test/?a=1&amp;b=2">Food</A></DL><p>
<DT><A HREF="https://top.fixture.test/">Top</A></DL>"#;

#[tokio::test]
async fn bookmarks_import_with_folders_once() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-IMPORT-BOOKMARKS")?.start().await?;
    let admin = admin(&s);
    let roots = profile_roots(&s.sandbox.home);
    let chrome = roots
        .chromium
        .iter()
        .find(|(browser, _)| *browser == "chrome")
        .unwrap()
        .1
        .clone();
    chromium_profile(&chrome)?;
    firefox_profile(&roots.firefox)?;
    if let Some(safari) = &roots.safari {
        std::fs::create_dir_all(safari.parent().unwrap())?;
        std::fs::write(safari, SAFARI)?;
    }
    let sources = admin
        .send(Method::GET, "/security/browser-import/sources", None, &[])
        .await?;
    let keys: Vec<String> = sources.data()["sources"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["key"].as_str().unwrap().to_owned())
        .collect();
    assert!(keys.contains(&"chrome:Default".to_owned()), "{keys:?}");
    assert!(
        keys.contains(&"firefox:ab12cd.default-release".to_owned()),
        "{keys:?}"
    );
    assert_eq!(sources.data()["sources"][0]["name"], "Work");

    let preview = post(
        &admin,
        "/security/browser-import/preview",
        json!({"kind":"bookmarks","source":"chrome:Default"}),
    )
    .await?;
    assert_eq!(
        preview,
        json!({"bookmarks": 2, "folders": 2}),
        "web URLs only, duplicates once"
    );
    let first = post(
        &admin,
        "/security/browser-import/run",
        json!({"kind":"bookmarks","source":"chrome:Default"}),
    )
    .await?;
    assert_eq!(
        (first["imported"].as_u64(), first["existing"].as_u64()),
        (Some(2), Some(0)),
        "{first}"
    );
    let again = post(
        &admin,
        "/security/browser-import/run",
        json!({"kind":"bookmarks","source":"chrome:Default"}),
    )
    .await?;
    assert_eq!(
        (again["imported"].as_u64(), again["existing"].as_u64()),
        (Some(0), Some(2)),
        "{again}"
    );
    let firefox = post(
        &admin,
        "/security/browser-import/run",
        json!({"kind":"bookmarks","source":"firefox:ab12cd.default-release"}),
    )
    .await?;
    assert_eq!(firefox["imported"], 2, "tags are not bookmarks: {firefox}");
    let html_path = s.sandbox.home.join("bookmarks.html");
    std::fs::write(&html_path, HTML)?;
    let html = post(
        &admin,
        "/security/browser-import/run",
        json!({"kind":"bookmarks","path":html_path}),
    )
    .await?;
    assert_eq!(html["imported"], 2, "{html}");
    if roots.safari.is_some() {
        let safari = post(
            &admin,
            "/security/browser-import/run",
            json!({"kind":"bookmarks","source":"safari:default"}),
        )
        .await?;
        assert_eq!(
            safari["imported"], 1,
            "reading list is not a bookmark: {safari}"
        );
    }
    let page = s.gw.get("/library?kind=bookmark").await?;
    let items = page.data()["items"].as_array().unwrap().clone();
    let folder = |url: &str| {
        items
            .iter()
            .find(|item| item["url"] == url)
            .map(|item| item["folder"].clone())
    };
    assert_eq!(
        folder("https://code.fixture.test/repo"),
        Some(json!("Bookmarks bar / Dev"))
    );
    assert_eq!(
        folder("https://paper.fixture.test/a"),
        Some(json!("Bookmarks Toolbar / Reading"))
    );
    assert_eq!(
        folder("https://food.fixture.test/?a=1&b=2"),
        Some(json!("Travel & Food"))
    );
    assert_eq!(
        items
            .iter()
            .filter(|item| item["url"] == "https://docs.fixture.test/")
            .count(),
        1
    );
    let refused = admin
        .send(
            Method::POST,
            "/security/browser-import/run",
            Some(json!({"kind":"passwords","path":html_path})),
            &[],
        )
        .await?;
    assert_eq!(
        refused.status, 409,
        "passwords need the keychain: {}",
        refused.text
    );
    s.finish().await
}

#[tokio::test]
async fn password_csv_exports_import_into_the_keychain_store() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        keychain_opt_in(),
        "system keychain check needs BUTLER_PLATFORM_SYSTEM_SECRETS=1"
    );
    let s = keychain_scenario("BROWSER-IMPORT-PASSWORDS").await?;
    let admin = admin(&s);
    let exports = tempfile_dir()?;
    let mut cleanup = super::fill::Cleanup::new(&admin);
    let files = [
        (
            "chrome.csv",
            format!(
                "name,url,username,password,note\nShop,https://www.fixture-shop.test/login,owner@fixture.test,{CANARY}-a,\n"
            ),
        ),
        (
            "safari.csv",
            format!(
                "Title,URL,Username,Password,Notes,OTPAuth\nMail,https://mail.fixture-mail.test/,owner,\"{CANARY},b\",,\n"
            ),
        ),
        (
            "firefox.csv",
            format!(
                "\"url\",\"username\",\"password\",\"httpRealm\",\"formActionOrigin\",\"guid\",\"timeCreated\",\"timeLastUsed\",\"timePasswordChanged\"\n\"https://news.fixture-news.test\",\"reader\",\"{CANARY}-c\",,\"\",\"{{1}}\",\"1\",\"1\",\"1\"\n\"android://x\",\"a\",\"b\",,,,,,\n"
            ),
        ),
    ];
    let mut ids = Vec::new();
    for (name, body) in &files {
        let path = exports.join(name);
        std::fs::write(&path, body)?;
        let preview = post(
            &admin,
            "/security/browser-import/preview",
            json!({"kind":"passwords","path":path}),
        )
        .await?;
        assert_eq!(preview["passwords"], 1, "{name}: {preview}");
        let run = post(
            &admin,
            "/security/browser-import/run",
            json!({"kind":"passwords","path":path}),
        )
        .await?;
        for row in admin
            .send(Method::GET, "/security/signins", None, &[])
            .await?
            .data()["sites"]
            .as_array()
            .unwrap()
        {
            cleanup.track(row["entry"]["id"].as_str().unwrap_or(""));
        }
        assert_eq!(run["imported"], 1, "{name}: {run}");
        let again = post(
            &admin,
            "/security/browser-import/run",
            json!({"kind":"passwords","path":path}),
        )
        .await?;
        assert_eq!(
            (again["imported"].as_u64(), again["updated"].as_u64()),
            (Some(0), Some(1)),
            "{name}: {again}"
        );
        assert!(!run.to_string().contains(CANARY) && !preview.to_string().contains(CANARY));
    }
    let rows = admin
        .send(Method::GET, "/security/signins", None, &[])
        .await?;
    assert!(!rows.text.contains(CANARY));
    for row in rows.data()["sites"].as_array().unwrap() {
        assert_eq!(row["entry"]["policy"], "ask", "{row}");
        ids.push(row["entry"]["id"].as_str().unwrap().to_owned());
    }
    assert_eq!(ids.len(), 3);
    for id in ids {
        assert_eq!(
            admin
                .send(
                    Method::DELETE,
                    &format!("/security/signins/{id}"),
                    None,
                    &[]
                )
                .await?
                .status,
            200
        );
    }
    super::canary_absent(&s.sandbox.data, CANARY, &s.agent.logs());
    std::fs::remove_dir_all(&exports)?;
    s.finish().await
}

fn tempfile_dir() -> Result<std::path::PathBuf, HarnessError> {
    let dir = std::env::temp_dir().join(format!("butler-import-{}", std::process::id()));
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}
