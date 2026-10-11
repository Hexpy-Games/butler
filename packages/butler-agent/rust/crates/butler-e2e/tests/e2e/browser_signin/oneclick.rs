//! One-click import through the authenticated host API, using only fixture profiles.
use super::host::admin;
use butler_e2e::e2e::{HarnessError, scenario::Setup, security::AdminClient};
use butler_platform::browser_profiles::profile_roots;
use reqwest::Method;
use serde_json::{Value, json};

async fn post(admin: &AdminClient, op: &str, body: Value) -> Result<Value, HarnessError> {
    let reply = admin
        .send(
            Method::POST,
            &format!("/security/browser-import/{op}"),
            Some(body),
            &[],
        )
        .await?;
    assert_eq!(reply.status, 200, "{op}: {}", reply.text);
    Ok(reply.data().clone())
}

#[tokio::test]
async fn detected_chromium_brands_use_local_state_profiles() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("BROWSER-IMPORT-BRANDS")?;
    let roots = profile_roots(&setup.sandbox.home);
    for (_, root) in &roots.chromium {
        std::fs::create_dir_all(root.join("Custom"))?;
        std::fs::write(
            root.join("Local State"),
            br#"{"profile":{"info_cache":{"Custom":{"name":"Fixture"}}}}"#,
        )?;
    }
    let s = setup.start().await?;
    let reply = admin(&s)
        .send(Method::GET, "/security/browser-import/sources", None, &[])
        .await?;
    let sources = reply.data()["sources"].as_array().unwrap();
    assert_eq!(sources.len(), roots.chromium.len());
    for (brand, _) in &roots.chromium {
        assert!(sources.iter().any(
            |source| source["key"] == format!("{brand}:Custom") && source["name"] == "Fixture"
        ));
    }
    s.finish().await
}

#[tokio::test]
async fn oneclick_profiles_folder_dedupe_and_exact_undo() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-IMPORT-ONECLICK")?.start().await?;
    let admin = admin(&s);
    let roots = profile_roots(&s.sandbox.home);
    let root = &roots
        .chromium
        .iter()
        .find(|(name, _)| *name == "chrome")
        .unwrap()
        .1;
    std::fs::create_dir_all(root.join("Person One"))?;
    std::fs::create_dir_all(root.join("Custom Two"))?;
    std::fs::write(root.join("Local State"), br#"{"profile":{"info_cache":{"Person One":{"name":"Work"},"Custom Two":{"name":"Personal"}}}}"#)?;
    let bookmarks = json!({"roots":{"bookmark_bar":{"name":"Work","children":[
        {"type":"url","name":"A","url":"https://same.fixture.test"},
        {"type":"url","name":"Duplicate","url":"https://same.fixture.test"}]},
        "other":{"name":"Home","children":[{"type":"url","name":"B","url":"https://same.fixture.test"}]}}});
    for id in ["Person One", "Custom Two"] {
        std::fs::write(
            root.join(id).join("Bookmarks"),
            serde_json::to_vec(&bookmarks)?,
        )?;
    }
    let sources = admin
        .send(Method::GET, "/security/browser-import/sources", None, &[])
        .await?;
    assert_eq!(sources.data()["sources"].as_array().unwrap().len(), 2);
    let request = json!({"source":"chrome:Person One","bookmarks":true,"passwords":false});
    let first = post(&admin, "start", request.clone()).await?;
    assert_eq!(first["bookmarks"], 2, "same URL is retained in each folder");
    let again = post(&admin, "start", request).await?;
    assert_eq!(again["bookmarks"], 0);
    assert_eq!(again["existing"], 2);
    let second = post(&admin, "undo", json!({"run_id":again["run_id"]})).await?;
    assert_eq!(second["bookmarks"], 0, "re-import owns no existing items");
    assert_eq!(
        s.gw.get("/library?kind=bookmark").await?.data()["items"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let undo = post(&admin, "undo", json!({"run_id":first["run_id"]})).await?;
    assert_eq!(undo["bookmarks"], 2);
    assert!(
        s.gw.get("/library?kind=bookmark").await?.data()["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        post(&admin, "undo", json!({"run_id":first["run_id"]})).await?["bookmarks"],
        0
    );
    s.finish().await
}

#[tokio::test]
async fn permission_denied_picker_and_locked_profile_retry() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("BROWSER-IMPORT-ACCESS")?;
    let roots = profile_roots(&setup.sandbox.home);
    let protected = &roots
        .chromium
        .iter()
        .find(|(b, _)| *b == "chrome")
        .unwrap()
        .1;
    let chosen = setup.sandbox.home.join("Chosen Profile");
    std::fs::create_dir_all(protected)?;
    std::fs::create_dir_all(&chosen)?;
    std::fs::write(chosen.join("Bookmarks"),br#"{"roots":{"bookmark_bar":{"name":"Work","children":[{"type":"url","url":"https://access.fixture.test","name":"Fixture"}]}}}"#)?;
    let s = setup
        .env(
            "BUTLER_BROWSER_IMPORT_DENIED_FIXTURE",
            protected.to_string_lossy(),
        )
        .env(
            "BUTLER_BROWSER_IMPORT_PICKED_FIXTURE",
            chosen.to_string_lossy(),
        )
        .start()
        .await?;
    let a = admin(&s);
    let list = a
        .send(Method::GET, "/security/browser-import/sources", None, &[])
        .await?;
    assert_eq!(list.data()["sources"][0]["permission"], "denied");
    let body = json!({"source":"chrome:blocked","bookmarks":true,"passwords":false});
    let denied = a
        .send(
            Method::POST,
            "/security/browser-import/start",
            Some(body.clone()),
            &[],
        )
        .await?;
    assert_eq!(denied.status, 422);
    assert_eq!(
        post(&a, "folder", json!({"source":"chrome:blocked"})).await?["selected"],
        true
    );
    assert_eq!(post(&a, "start", body).await?["bookmarks"], 1);
    s.finish().await
}

#[tokio::test]
async fn firefox_wal_snapshot_and_profile_lock_retry() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("BROWSER-IMPORT-LOCK")?;
    let root = profile_roots(&setup.sandbox.home).firefox;
    let base = if root.file_name().is_some_and(|n| n == "Profiles") {
        root.parent().unwrap()
    } else {
        &root
    };
    let dir = root.join("fixture");
    std::fs::create_dir_all(&dir)?;
    let path = dir.strip_prefix(base).unwrap().to_string_lossy();
    std::fs::write(
        base.join("profiles.ini"),
        format!("[Profile0]\nName=Fixture\nPath={path}\nIsRelative=1\n"),
    )?;
    let db = rusqlite::Connection::open(dir.join("places.sqlite")).unwrap();
    db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE moz_places(id INTEGER PRIMARY KEY,url TEXT); CREATE TABLE moz_bookmarks(id INTEGER PRIMARY KEY,type INTEGER,fk INTEGER,parent INTEGER,position INTEGER,title TEXT,guid TEXT); INSERT INTO moz_places VALUES(1,'https://wal.fixture.test'); INSERT INTO moz_bookmarks VALUES(1,2,NULL,0,0,'Work','toolbar_____'),(2,1,1,1,0,'WAL','b1');").unwrap();
    let s = setup.start().await?;
    let a = admin(&s);
    let body = json!({"source":"firefox:fixture","bookmarks":true,"passwords":false});
    assert_eq!(
        post(&a, "start", body.clone()).await?["bookmarks"],
        1,
        "committed WAL while DB stays open"
    );
    let lock_path = dir.join(".parentlock");
    let lock = butler_platform::browser_transfer::fixture_profile_lock(&lock_path)?;
    let locked = a
        .send(
            Method::POST,
            "/security/browser-import/start",
            Some(body.clone()),
            &[],
        )
        .await?;
    assert_eq!(locked.status, 422);
    drop(lock);
    assert!(
        lock_path.exists(),
        "Firefox leaves its unlocked marker behind"
    );
    assert_eq!(post(&a, "start", body).await?["existing"], 1);
    drop(db);
    s.finish().await
}
