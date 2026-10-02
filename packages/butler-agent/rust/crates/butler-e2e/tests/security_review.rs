//! Adversarial regressions from the 2026-10-02 security review.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
#[path = "gateway_pairing/helpers.rs"]
mod pairing;
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use serde_json::json;

#[tokio::test]
async fn stolen_cookie_expires_on_server_and_stays_expired_after_restart()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("REVIEW-COOKIE-EXPIRY")?
        .data_folder_token()
        .start()
        .await?;
    let app = pairing::admin(&s);
    let browser = pairing::browser();
    let pin = pairing::issue(&app).await?;
    let response = pairing::connect(&s.gw, &browser, pin["code"].as_str().unwrap()).await?;
    assert_eq!(response.status().as_u16(), 303);
    let cookie = pairing::cookie_pair(&response);
    assert_eq!(pairing::read(&s.gw, &browser, &cookie).await?, 200);
    // Age the durable issuance time to one hour before expiry. The debug
    // clock limits each advance to one hour; no wall-clock wait is needed.
    s.agent.terminate().await?;
    age_devices(&s, 2_592_000 - 3600);
    s.gw = s.agent.start_again().await?;
    assert_eq!(pairing::read(&s.gw, &browser, &cookie).await?, 200);
    pairing::advance(&pairing::admin(&s), 3600).await?;
    assert_eq!(pairing::read(&s.gw, &browser, &cookie).await?, 401);
    s.agent.terminate().await?;
    age_devices(&s, 3600);
    s.gw = s.agent.start_again().await?;
    assert_eq!(pairing::read(&s.gw, &browser, &cookie).await?, 401);
    pairing::assert_no_secrets(&s, &[&cookie])?;
    s.finish().await
}

fn age_devices(s: &butler_e2e::e2e::scenario::Scenario, seconds: u64) {
    let db =
        rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite")).unwrap();
    assert_eq!(
        db.execute(
            "UPDATE paired_devices SET created_at=created_at-?1",
            [seconds]
        )
        .unwrap(),
        1
    );
}

#[tokio::test]
async fn app_update_rejects_remote_plain_http_manifest_and_artifact() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("REVIEW-UPDATE-TRANSPORT")?.env("BUTLER_APP_VERSION", "0.0.1");
    let manifest = setup.sandbox.root.join("manifest.json");
    std::fs::write(&manifest, json!({"artifacts":[{
        "component":"app", "version":"99.0.0", "channel":"stable",
        "staging_policy":"butler-data-updates", "activation_policy":"user-installs-app-package",
        "rollback_policy":"not-managed-by-butler", "package_format":butler_platform::app_update::package_format(),
        "artifact_url":"http://192.0.2.1/payload.deb", "sha256":"0".repeat(64)
    }]}).to_string())?;
    let s = setup
        .env("BUTLER_APP_UPDATE_MANIFEST", manifest.to_string_lossy())
        .start()
        .await?;
    let check =
        s.gw.post("/updates/check", json!({"component":"app"}))
            .await?;
    assert_eq!(check.status, 200);
    assert_eq!(
        check.data()["components"][0]["check_error"],
        "update_artifact_source_invalid"
    );
    s.finish().await?;
    let s = Setup::new("REVIEW-MANIFEST-TRANSPORT")?
        .env("BUTLER_APP_VERSION", "0.0.1")
        .env(
            "BUTLER_APP_UPDATE_MANIFEST",
            "http://192.0.2.1/manifest.json",
        )
        .start()
        .await?;
    let check =
        s.gw.post("/updates/check", json!({"component":"app"}))
            .await?;
    assert_eq!(check.status, 200);
    assert_eq!(
        check.data()["components"][0]["check_error"],
        "update_manifest_source_invalid"
    );
    s.finish().await
}

#[tokio::test]
async fn parallel_pairing_guesses_invalidate_and_redemption_is_single_use()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("REVIEW-PAIRING-RACE")?
        .data_folder_token()
        .start()
        .await?;
    let app = pairing::admin(&s);
    let browser = pairing::browser();
    let pin = pairing::issue(&app).await?;
    let guesses = (0..16).map(|_| pairing::connect(&s.gw, &browser, "wrong"));
    for response in futures_util::future::join_all(guesses).await {
        assert_eq!(response?.status().as_u16(), 401);
    }
    pairing::rejected(&s.gw, &browser, pin["code"].as_str().unwrap()).await?;
    assert_eq!(pairing::devices(&app).await?, json!([]));
    let pin = pairing::issue(&app).await?;
    let redeemers =
        (0..16).map(|_| pairing::connect(&s.gw, &browser, pin["code"].as_str().unwrap()));
    let mut successes = 0;
    for response in futures_util::future::join_all(redeemers).await {
        match response?.status().as_u16() {
            303 => successes += 1,
            401 => {}
            status => panic!("unexpected pairing status {status}"),
        }
    }
    assert_eq!(successes, 1);
    assert_eq!(pairing::devices(&app).await?.as_array().unwrap().len(), 1);
    s.finish().await
}

#[tokio::test]
async fn app_update_does_not_follow_plain_http_redirect_outside_trusted_loopback()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    // The unspecified address reaches this local listener but is outside the
    // updater's exact loopback allowlist. No OS-specific loopback alias needed.
    let target = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let target_port = target.local_addr()?.port();
    drop(tokio::net::TcpStream::connect(("0.0.0.0", target_port)).await?);
    let hits = Arc::new(AtomicUsize::new(0));
    let seen = hits.clone();
    let app = axum::Router::new().fallback(move || {
        let seen = seen.clone();
        async move {
            seen.fetch_add(1, Ordering::SeqCst);
            axum::Json(json!({"artifacts":[{
                "component":"app", "version":"99.0.0", "channel":"stable",
                "staging_policy":"butler-data-updates", "activation_policy":"user-installs-app-package",
                "rollback_policy":"not-managed-by-butler"
            }]}))
        }
    });
    let target_task = tokio::spawn(async move { axum::serve(target, app).await });
    let redirect = format!("http://0.0.0.0:{target_port}/manifest.json");
    let app = axum::Router::new().fallback(move || {
        let redirect = redirect.clone();
        async move { axum::response::Redirect::temporary(&redirect) }
    });
    let source_task = tokio::spawn(async move { axum::serve(listener, app).await });
    let s = Setup::new("REVIEW-UPDATE-REDIRECT")?
        .env("BUTLER_APP_VERSION", "0.0.1")
        .env(
            "BUTLER_APP_UPDATE_MANIFEST",
            format!("http://127.0.0.1:{port}/manifest.json"),
        )
        .start()
        .await?;
    let check =
        s.gw.post("/updates/check", json!({"component":"app"}))
            .await?;
    source_task.abort();
    target_task.abort();
    assert_eq!(check.status, 200);
    assert_eq!(
        check.data()["components"][0]["check_error"],
        "update_manifest_unavailable"
    );
    assert_eq!(
        hits.load(Ordering::SeqCst),
        0,
        "untrusted redirect was fetched"
    );
    s.finish().await
}

#[tokio::test]
async fn legacy_consent_version_without_acceptance_requires_renewal() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    use butler_e2e::e2e::scenario::Fixture;
    let mut s = Setup::new("REVIEW-LEGACY-CONSENT")?
        .fixture(Fixture::Empty)
        .start()
        .await?;
    s.agent.terminate().await?;
    let db =
        rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite")).unwrap();
    db.execute("INSERT INTO app_settings(key,value_json,updated_at) VALUES('settings',?1,'now') ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
        [json!({"onboarding":{"consent_version":2,"accepted_at":null,"completed_at":"2026-10-01T00:00:00Z"}}).to_string()]).unwrap();
    drop(db);
    s.gw = s.agent.start_again().await?;
    let view = s.gw.settings().await?;
    assert_eq!(
        view["onboarding"]["consent_version"],
        serde_json::Value::Null
    );
    assert_eq!(view["onboarding"]["completed_at"], "2026-10-01T00:00:00Z");
    let renewed =
        s.gw.patch(
            "/settings",
            json!({"onboarding":{"consent_version":2,"accepted_at":"2026-10-02T00:00:00Z"}}),
        )
        .await?;
    assert_eq!(renewed.status, 200);
    s.restart().await?;
    assert_eq!(
        s.gw.settings().await?["onboarding"],
        renewed.data()["onboarding"]
    );
    s.finish().await
}

#[tokio::test]
async fn appimage_failed_launch_restores_and_relaunches_previous_image() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        butler_platform::launcher::release_platform().starts_with("linux-"),
        "Linux AppImage activation"
    );
    use butler_e2e::e2e::{agent::Launch, executable, sandbox::Sandbox};
    use std::{io::Write, process::Stdio};
    let sandbox = Sandbox::new("REVIEW-APPIMAGE-ROLLBACK")?;
    let launch = Launch::new(&sandbox)?;
    let image = sandbox.root.join("Butler.AppImage");
    let artifact = sandbox.root.join("candidate.AppImage");
    let marker = sandbox.root.join("restored");
    let previous = "#!/bin/sh\nprintf restored > \"$1\"\n";
    executable::write_script(&image, previous)?;
    std::fs::write(&artifact, b"unlaunchable package fixture\n")?;
    let mut parent = launch.command().arg("help").stdout(Stdio::null()).spawn()?;
    let parent_pid = parent.id();
    assert!(parent.wait()?.success());
    let mut command = launch.command();
    command
        .env("APPIMAGE", &image)
        .arg("app-update-install")
        .arg(&artifact)
        .arg(&image)
        .arg(parent_pid.to_string())
        .arg(&marker)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Preparation without the Electron host's commit signal cannot swap anything.
    let cancelled = command.stdin(Stdio::null()).output()?;
    assert!(!cancelled.status.success());
    assert_eq!(std::fs::read(&image)?, previous.as_bytes());
    assert!(!marker.exists());
    let mut helper = command.stdin(Stdio::piped()).spawn()?;
    helper.stdin.take().unwrap().write_all(b"activate\n")?;
    let result = helper.wait_with_output()?;
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stdout).contains("app-update-ready"));
    assert_eq!(
        std::fs::read(&image)?,
        previous.as_bytes(),
        "failed update lost the installed image"
    );
    appimage_marker(&marker, b"restored").await;
    let candidate = "#!/bin/sh\nprintf updated > \"$1\"\n";
    std::fs::write(&artifact, candidate)?;
    std::fs::remove_file(&marker)?;
    let mut helper = command.spawn()?;
    helper.stdin.take().unwrap().write_all(b"activate\n")?;
    assert!(helper.wait_with_output()?.status.success());
    appimage_marker(&marker, b"updated").await;
    assert_eq!(std::fs::read(&image)?, candidate.as_bytes());
    for entry in std::fs::read_dir(&sandbox.root)? {
        assert!(
            !entry?
                .file_name()
                .to_string_lossy()
                .starts_with(".Butler.AppImage."),
            "activation left a temporary image"
        );
    }
    Ok(())
}

async fn appimage_marker(path: &std::path::Path, expected: &[u8]) {
    use std::time::{Duration, Instant};
    let deadline = Instant::now() + Duration::from_secs(5);
    while std::fs::read(path).ok().as_deref() != Some(expected) {
        assert!(
            Instant::now() < deadline,
            "App launch marker did not complete"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn cookie_expiry_closes_existing_sse_without_another_request() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    use futures_util::StreamExt;
    use std::time::Duration;
    let mut s = Setup::new("REVIEW-COOKIE-STREAM-EXPIRY")?
        .data_folder_token()
        .start()
        .await?;
    let browser = pairing::browser();
    let pin = pairing::issue(&pairing::admin(&s)).await?;
    let response = pairing::connect(&s.gw, &browser, pin["code"].as_str().unwrap()).await?;
    assert_eq!(response.status().as_u16(), 303);
    let cookie = pairing::cookie_pair(&response);
    s.agent.terminate().await?;
    age_devices(&s, 2_592_000 - 20);
    s.gw = s.agent.start_again().await?;
    let response = browser
        .get(format!("{}/events/live?cursor=0", s.gw.base))
        .header("cookie", &cookie)
        .header("sec-fetch-site", "same-origin")
        .send()
        .await?;
    assert_eq!(response.status().as_u16(), 200);
    let complete = async {
        let mut stream = response.bytes_stream();
        let mut received = Vec::new();
        while let Some(chunk) = stream.next().await {
            received.extend_from_slice(&chunk?);
        }
        Ok::<_, reqwest::Error>(received)
    };
    let received = tokio::time::timeout(Duration::from_secs(25), complete)
        .await
        .expect("expired credential kept its SSE connection open")?;
    assert!(String::from_utf8_lossy(&received).contains("security.device_paired"));
    // No request above re-authenticates the cookie to trigger cancellation.
    assert_eq!(pairing::read(&s.gw, &browser, &cookie).await?, 401);
    s.finish().await
}
