//! Native fixture decryption into the real keychain-backed sign-in store.
use super::{
    fill::{Cleanup, keychain_opt_in},
    host::admin,
};
use butler_e2e::e2e::{
    HarnessError,
    scenario::{Scenario, Setup},
};
use butler_platform::browser_profiles::profile_roots;
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
    let s = super::vault::vault_scenario("BROWSER-IMPORT-NSS", None).await?;
    let a = admin(&s);
    let mut cleanup = Cleanup::new(&a);
    for name in [
        "firefox-empty",
        "firefox-primary",
        "firefox-legacy",
        "firefox-aes",
    ] {
        let source = firefox(&s.sandbox.home, name)?;
        let mut body = json!({"source":source,"bookmarks":false,"passwords":true});
        if name != "firefox-empty" {
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
            body["primary_password"] = json!("wrong-primary");
            let wrong = a
                .send(
                    Method::POST,
                    "/security/browser-import/start",
                    Some(body.clone()),
                    &[],
                )
                .await?;
            assert_eq!(wrong.body["error"]["code"], "incorrect_primary_password");
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
        assert_eq!(run.data()["passwords"], 1);
        assert_eq!(run.data()["updated"], 0);
        assert_imported_password(&s, &view.data()["sites"][0]["entry"]).await?;
        assert!(!run.text.contains(CANARY));
        let undo = a
            .send(
                Method::POST,
                "/security/browser-import/undo",
                Some(json!({"run_id":run.data()["run_id"]})),
                &[],
            )
            .await?;
        assert_eq!(undo.data()["passwords"], 1);
    }
    super::canary_absent(&s.sandbox.data, CANARY, &s.agent.logs());
    drop(cleanup);
    s.finish().await
}

#[tokio::test]
async fn chromium_mac_injected_safe_storage_skips_invalid_rows() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        butler_platform::browser_transfer::chromium_safe_storage_fixture_supported(),
        "Safe Storage fixture requires macOS"
    );
    butler_e2e::skip_unless!(
        keychain_opt_in(),
        "isolated system-store test opt-in required"
    );
    let setup = Setup::new("BROWSER-IMPORT-CHROMIUM-MAC")?.env("BUTLER_SECRET_STORE", "");
    butler_platform::secrets::prepare_system_keychain_for_test(&setup.sandbox.home)?;
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
    let db = rusqlite::Connection::open(dir.join("Login Data"))
        .map_err(|e| butler_e2e::e2e::harness_error(e.to_string()))?;
    for encrypted in [b"v20unsupported".as_slice(), b"v10corrupt".as_slice()] {
        db.execute("INSERT INTO logins(origin_url,username_value,password_value,blacklisted_by_user) VALUES('https://bad.fixture.test','bad',?1,0)", [encrypted]).map_err(|e| butler_e2e::e2e::harness_error(e.to_string()))?;
    }
    drop(db);
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
        return s.finish().await;
    }
    let folder = a
        .send(
            Method::POST,
            "/security/browser-import/folder",
            Some(json!({"source":"chrome:Work","path":dir})),
            &[],
        )
        .await?;
    assert_eq!(folder.status, 200, "password-only profile layout");
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
    assert_eq!(run.data()["invalid"], 2);
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
    s.finish().await
}

/// Exercise the public fill path, proving the decrypted value without logging it.
async fn assert_imported_password(s: &Scenario, entry: &Value) -> Result<(), HarnessError> {
    assert_password(s, entry, CANARY).await
}

pub(super) async fn assert_password(
    s: &Scenario,
    entry: &Value,
    expected: &'static str,
) -> Result<(), HarnessError> {
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
                    *received.lock().unwrap() = reply.body["password"].as_str() == Some(expected);
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

#[tokio::test]
async fn chromium_dpapi_import_reports_csv_and_undoes_v10() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("BROWSER-IMPORT-DPAPI")?.env("BUTLER_SECRET_STORE", "");
    let roots = profile_roots(&setup.sandbox.home);
    for browser in ["chrome", "edge", "brave"] {
        let root = &roots
            .chromium
            .iter()
            .find(|(b, _)| *b == browser)
            .unwrap()
            .1;
        butler_e2e::skip_unless!(
            butler_platform::browser_transfer::chromium_password_fixture(root, CANARY)?,
            "current-user DPAPI fixture requires Windows"
        );
    }
    let s = setup.start().await?;
    std::fs::write(
        s.sandbox.data.join("butler.config.json"),
        br#"{"secrets":{"store":"system"}}"#,
    )?;
    let a = admin(&s);
    let mut cleanup = Cleanup::new(&a);
    for browser in ["chrome", "edge", "brave"] {
        let run = a
            .send(
                Method::POST,
                "/security/browser-import/start",
                Some(
                    json!({"source":format!("{browser}:Work"),"bookmarks":false,"passwords":true}),
                ),
                &[],
            )
            .await?;
        assert_eq!(run.status, 200, "{}", run.text);
        assert_eq!(run.data()["passwords"], 1);
        assert_eq!(run.data()["invalid"], 2);
        assert_eq!(run.data()["csv_required"], 1);
        assert_eq!(run.data()["needs_csv"], true);
        let view = a.send(Method::GET, "/security/signins", None, &[]).await?;
        let entry = &view.data()["sites"][0]["entry"];
        cleanup.track(entry["id"].as_str().unwrap());
        assert_imported_password(&s, entry).await?;
        let undo = a
            .send(
                Method::POST,
                "/security/browser-import/undo",
                Some(json!({"run_id":run.data()["run_id"]})),
                &[],
            )
            .await?;
        assert_eq!(undo.data()["passwords"], 1);
        // App-bound-only profiles must still return a CSV fallback without a legacy key.
        let root = &roots
            .chromium
            .iter()
            .find(|(b, _)| *b == browser)
            .unwrap()
            .1;
        let db = rusqlite::Connection::open(root.join("Work/Login Data"))?;
        db.execute(
            "DELETE FROM logins WHERE substr(password_value,1,3) != X'763230'",
            [],
        )?;
        drop(db);
        let path = root.join("Local State");
        let mut state: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
        state["os_crypt"] = json!({});
        std::fs::write(path, serde_json::to_vec(&state)?)?;
        let only_bound = a
            .send(
                Method::POST,
                "/security/browser-import/start",
                Some(
                    json!({"source":format!("{browser}:Work"),"bookmarks":false,"passwords":true}),
                ),
                &[],
            )
            .await?;
        assert_eq!(only_bound.status, 200);
        assert_eq!(only_bound.data()["passwords"], 0);
        assert_eq!(only_bound.data()["invalid"], 0);
        assert_eq!(only_bound.data()["csv_required"], 1);
        assert_eq!(only_bound.data()["needs_csv"], true);
    }
    super::canary_absent(&s.sandbox.data, CANARY, &s.agent.logs());
    drop(cleanup);
    s.finish().await
}
