//! Native fixture decryption into the real keychain-backed sign-in store.
use super::{
    fill::{Cleanup, keychain_opt_in, keychain_scenario},
    host::admin,
};
use butler_e2e::e2e::{
    HarnessError,
    scenario::{Scenario, Setup},
};
use butler_platform::{
    browser_profiles::profile_roots,
    secrets::{SecretKey, SecretStore},
};
use reqwest::Method;
use serde_json::{Value, json};
use std::path::Path;
use std::sync::{Arc, Mutex};

const CANARY: &str = "canary-native-723ac8";
fn fixture(name: &str, file: &str, destination: &Path) -> Result<(), HarnessError> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures/browser-import")
        .join(name)
        .join(file);
    std::fs::copy(path, destination)?;
    Ok(())
}
fn firefox(home: &Path, name: &str) -> Result<String, HarnessError> {
    let root = profile_roots(home).firefox;
    let base = if root.file_name().is_some_and(|n| n == "Profiles") {
        root.parent().unwrap()
    } else {
        &root
    };
    let dir = root.join(name);
    std::fs::create_dir_all(&dir)?;
    let relative = dir.strip_prefix(base).unwrap().to_string_lossy();
    std::fs::write(
        base.join("profiles.ini"),
        format!("[Profile0]\nName=Fixture\nIsRelative=1\nPath={relative}\n"),
    )?;
    for file in ["key4.db", "logins.json"] {
        fixture(name, file, &dir.join(file))?;
    }
    Ok(format!("firefox:{name}"))
}
#[tokio::test]
async fn firefox_nss_with_and_without_primary_password() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        keychain_opt_in(),
        "isolated system-store test opt-in required"
    );
    let s = keychain_scenario("BROWSER-IMPORT-NSS").await?;
    let a = admin(&s);
    let mut cleanup = Cleanup::new(&a);
    for name in ["firefox-empty", "firefox-primary"] {
        let source = firefox(&s.sandbox.home, name)?;
        let mut body = json!({"source":source,"bookmarks":false,"passwords":true});
        if name == "firefox-primary" {
            let reply = a
                .send(
                    Method::POST,
                    "/security/browser-import/start",
                    Some(body.clone()),
                    &[],
                )
                .await?;
            assert_eq!(
                reply.body["error"]["code"], "primary_password_required",
                "{}",
                reply.text
            );
            body["primary_password"] = json!("fixture-primary");
        }
        let run = a
            .send(
                Method::POST,
                "/security/browser-import/start",
                Some(body.clone()),
                &[],
            )
            .await?;
        let view = a.send(Method::GET, "/security/signins", None, &[]).await?;
        for row in view.data()["sites"].as_array().unwrap() {
            cleanup.track(row["entry"]["id"].as_str().unwrap());
            assert_eq!(row["entry"]["policy"], "ask");
        }
        assert_eq!(run.status, 200, "{}", run.text);
        assert_eq!(
            run.data()["passwords"],
            usize::from(name == "firefox-empty")
        );
        assert_eq!(run.data()["updated"], usize::from(name != "firefox-empty"));
        assert_imported_password(&s, &view.data()["sites"][0]["entry"]).await?;
        assert!(!run.text.contains(CANARY));
    }
    super::canary_absent(&s.sandbox.data, CANARY, &s.agent.logs());
    drop(cleanup);
    s.finish().await
}

struct SourceKey {
    store: SecretStore,
    key: SecretKey,
}
impl Drop for SourceKey {
    fn drop(&mut self) {
        let _ = self.store.delete(&self.key);
    }
}
#[tokio::test]
async fn chromium_mac_safe_storage_fixture_item_only() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        keychain_opt_in(),
        "isolated system-store test opt-in required"
    );
    let service = format!("com.hexpy.butler.e2e.import.{}", uuid::Uuid::new_v4());
    let store = SecretStore::system().unwrap();
    let key = SecretKey::new(&service, "Chrome").unwrap();
    let source_key = SourceKey { store, key };
    source_key
        .store
        .set(&source_key.key, "fixture-safe-storage")
        .unwrap();
    let setup = Setup::new("BROWSER-IMPORT-CHROMIUM-MAC")?
        .env("BUTLER_SECRET_STORE", "")
        .env("BUTLER_BROWSER_IMPORT_TEST_SERVICE", &service);
    super::fill::link_keychains(&setup.sandbox.home)?;
    let roots = profile_roots(&setup.sandbox.home);
    let root = &roots
        .chromium
        .iter()
        .find(|(b, _)| *b == "chrome")
        .unwrap()
        .1;
    let dir = root.join("Work");
    std::fs::create_dir_all(&dir)?;
    std::fs::write(
        root.join("Local State"),
        br#"{"profile":{"info_cache":{"Work":{"name":"Work"}}}}"#,
    )?;
    fixture("", "chromium-login.sqlite", &dir.join("Login Data"))?;
    let s = setup.start().await?;
    std::fs::write(
        s.sandbox.data.join("butler.config.json"),
        br#"{"secrets":{"store":"system"}}"#,
    )?;
    let a = admin(&s);
    let mut cleanup = Cleanup::new(&a);
    let sources = a
        .send(Method::GET, "/security/browser-import/sources", None, &[])
        .await?;
    let mode = &sources.data()["sources"][0]["passwords"];
    if mode != "direct" {
        drop(source_key);
        return s.finish().await;
    }
    let run = a
        .send(
            Method::POST,
            "/security/browser-import/start",
            Some(json!({"source":"chrome:Work","bookmarks":false,"passwords":true})),
            &[],
        )
        .await?;
    let view = a.send(Method::GET, "/security/signins", None, &[]).await?;
    for row in view.data()["sites"].as_array().unwrap() {
        cleanup.track(row["entry"]["id"].as_str().unwrap());
    }
    assert_eq!(run.status, 200, "{}", run.text);
    assert_eq!(run.data()["passwords"], 1);
    assert_imported_password(&s, &view.data()["sites"][0]["entry"]).await?;
    let undo = a
        .send(
            Method::POST,
            "/security/browser-import/undo",
            Some(json!({"run_id":run.data()["run_id"]})),
            &[],
        )
        .await?;
    assert_eq!(undo.data()["passwords"], 1);
    super::canary_absent(&s.sandbox.data, CANARY, &s.agent.logs());
    drop(cleanup);
    drop(source_key);
    s.finish().await
}

/// Exercise the public fill path, proving the decrypted value without logging it.
async fn assert_imported_password(s: &Scenario, entry: &Value) -> Result<(), HarnessError> {
    use super::host::{attach, call, snapshot, tab};
    let a = admin(s);
    let origin = entry["origins"][0].as_str().unwrap().to_owned();
    let pulled = Arc::new(Mutex::new(false));
    let (host_admin, host_origin, received) = (a.clone(), origin.clone(), pulled.clone());
    let host = attach(
        s,
        Arc::new(move |frame: Value| {
            let (a, origin, received) = (host_admin.clone(), host_origin.clone(), received.clone());
            Box::pin(async move {
                if frame["op"] == "signin.fill" {
                    let token = frame["args"]["fill_token"].as_str().unwrap();
                    let reply = a
                        .send(
                            Method::POST,
                            &format!("/internal/browser-host/credentials/{token}"),
                            Some(json!({"origin":origin})),
                            &[],
                        )
                        .await
                        .unwrap();
                    assert_eq!(reply.status, 200, "fixture credential pull");
                    *received.lock().unwrap() = reply.body["password"].as_str() == Some(CANARY);
                    json!({"status":"filled","url":origin})
                } else {
                    json!({"status":"ok","tab":frame["tab"],"url":origin})
                }
            })
        }),
    )
    .await?;
    snapshot(
        &a,
        json!([tab(
            "t1",
            "conversation:general",
            &format!("{origin}/login"),
            "agent"
        )]),
    )
    .await?;
    call(
        &a,
        "general",
        "signin.grant",
        "",
        json!({"site":entry["site"]}),
    )
    .await?;
    let filled = call(
        &a,
        "general",
        "signin.fill",
        "t1",
        json!({"entry_id":entry["id"]}),
    )
    .await?;
    assert_eq!(filled["status"], "filled");
    assert!(
        *pulled.lock().unwrap(),
        "imported password must match the fixture"
    );
    assert!(
        !host
            .last("signin.fill")
            .unwrap()
            .to_string()
            .contains(CANARY)
    );
    drop(host);
    Ok(())
}
