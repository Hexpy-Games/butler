//! Checking a feed never means that an available update failed to install.
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use serde_json::json;

#[tokio::test]
async fn fresh_preview_missing_platform_and_unreachable_feed_stay_calm() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let setup = Setup::new("UPDATE-CHECK-CALM")?.env("BUTLER_APP_VERSION", "0.1.0-preview.11");
    let manifest = setup.sandbox.root.join("manifest.json");
    std::fs::write(
        &manifest,
        json!({"artifacts":[{
            "component":"app", "version":"0.0.9", "channel":"stable",
            "platform":"missing-platform"
        }]})
        .to_string(),
    )?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let source = format!("http://{}/manifest", listener.local_addr()?);
    let served = manifest.clone();
    let feed = axum::Router::new().route(
        "/manifest",
        axum::routing::get(move || {
            let path = served.clone();
            async move { tokio::fs::read(path).await.unwrap_or_default() }
        }),
    );
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, feed).await;
    });
    let s = setup
        .env("BUTLER_APP_UPDATE_MANIFEST", source)
        .start()
        .await?;
    let request = json!({"component":"app", "channel":"stable"});
    let result = s.gw.post("/updates/check", request.clone()).await?;
    assert_eq!(result.status, 200, "{}", result.text);
    let view = result.data();
    assert_eq!(view["components"][0]["current_version"], "0.1.0-preview.11");
    assert_eq!(view["components"][0]["check_state"], "unavailable");
    assert_eq!(
        view["components"][0]["check_error"],
        "update_manifest_app_platform_missing"
    );
    assert_eq!(view["components"][0]["update_available"], false);
    assert_eq!(view["progress"]["stage"], "completed");
    assert!(view["progress"]["error_code"].is_null());
    let apply = s.gw.post("/updates/apply", request.clone()).await?;
    assert_eq!(
        apply.error_code(),
        Some("update_manifest_app_platform_missing")
    );
    assert_eq!(
        s.gw.get("/updates").await?.data()["progress"]["stage"],
        "completed"
    );
    // A subsequent check recovers without ever producing a failure revision.
    std::fs::write(
        &manifest,
        json!({"artifacts":[{
            "component":"app", "version":"0.0.9", "channel":"stable",
            "platform":butler_platform::launcher::release_platform(),
            "staging_policy":"butler-data-updates", "activation_policy":"user-installs-app-package",
            "rollback_policy":"not-managed-by-butler"
        }]})
        .to_string(),
    )?;
    let recovered = s.gw.post("/updates/check", request.clone()).await?;
    assert_eq!(recovered.status, 200, "{}", recovered.text);
    assert_eq!(recovered.data()["components"][0]["check_state"], "ok");
    assert_eq!(recovered.data()["components"][0]["update_available"], false);
    assert_eq!(recovered.data()["progress"]["stage"], "completed");
    task.abort();
    let _ = task.await;
    let check = s.gw.post("/updates/check", request).await?;
    assert_eq!(check.status, 200, "{}", check.text);
    assert_eq!(
        check.data()["components"][0]["check_error"],
        "update_manifest_unavailable"
    );
    assert_eq!(check.data()["progress"]["stage"], "completed");
    let events = s.gw.events_since(0).await?;
    assert!(
        events
            .iter()
            .filter(|e| e["type"] == "updates.progress")
            .all(|e| e["payload"]["progress"]["stage"] != "failed")
    );
    s.finish().await
}

pub(super) async fn failed_download(
    gw: &butler_e2e::e2e::gateway::Gateway,
    seed_cursor: u64,
) -> Result<(), HarnessError> {
    let events = super::subscribe(gw, seed_cursor).await?;
    let result = gw
        .post("/updates/apply", json!({"component":"app"}))
        .await?;
    assert_eq!(result.error_code(), Some("update_artifact_unavailable"));
    super::wait(&events, "failed").await?;
    let response = gw.get("/updates").await?;
    let view = response.data();
    assert_eq!(view["components"][0]["update_available"], true);
    assert_eq!(view["progress"]["stage"], "failed");
    assert_eq!(
        view["progress"]["error_code"],
        "update_artifact_unavailable"
    );
    Ok(())
}

#[tokio::test]
async fn unsupported_local_build_has_no_update_progress() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("UPDATE-UNSUPPORTED")?
        .env("BUTLER_APP_VERSION", "")
        .start()
        .await?;
    for path in ["/updates/check", "/updates/apply"] {
        let response = s.gw.post(path, json!({"component":"app"})).await?;
        assert_eq!(response.error_code(), Some("app_version_unavailable"));
    }
    assert!(
        s.gw.events_since(0)
            .await?
            .iter()
            .all(|event| event["type"] != "updates.progress")
    );
    s.finish().await
}
