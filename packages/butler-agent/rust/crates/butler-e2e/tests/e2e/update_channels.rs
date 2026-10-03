//! Preview preference uses the public settings path and real manifest selection.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use serde_json::json;

#[tokio::test]
async fn preview_channel_persists_and_orders_semver() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("UPDATE-CHANNEL")?.env("BUTLER_APP_VERSION", "0.1.0-preview.9");
    let manifest = setup.sandbox.root.join("app-update-manifest.json");
    let artifacts = ["0.1.0-preview.9", "0.1.0-preview.10", "0.0.9"].map(|version| {
        json!({
            "component":"app", "version":version,
            "channel": if version.contains("preview") {"preview"} else {"stable"},
            "staging_policy":"butler-data-updates", "activation_policy":"user-installs-app-package",
            "rollback_policy":"not-managed-by-butler"
        })
    });
    std::fs::write(&manifest, json!({"artifacts":artifacts}).to_string())?;
    let setup = setup.env("BUTLER_APP_UPDATE_MANIFEST", manifest.to_string_lossy());
    let mut s = setup.start().await?;
    let off =
        s.gw.post("/updates/check", json!({"component":"app"}))
            .await?;
    assert_eq!(off.status, 200, "{}", off.text);
    assert_eq!(off.data()["components"][0]["update_available"], false);
    let enabled =
        s.gw.patch("/settings", json!({"update_previews":true}))
            .await?;
    assert_eq!(enabled.status, 200, "{}", enabled.text);
    assert_eq!(enabled.data()["update_previews"], true);
    let on =
        s.gw.post("/updates/check", json!({"component":"app"}))
            .await?;
    assert_eq!(on.status, 200, "{}", on.text);
    assert_eq!(
        on.data()["components"][0]["available_version"],
        "0.1.0-preview.10"
    );
    assert_eq!(on.data()["components"][0]["update_available"], true);
    let saved: serde_json::Value =
        serde_json::from_slice(&std::fs::read(s.sandbox.data.join("butler.config.json"))?)?;
    assert_eq!(saved["update"]["previews"], true);
    let disabled =
        s.gw.patch("/settings", json!({"update_previews":false}))
            .await?;
    assert_eq!(disabled.status, 200);
    let hidden = s.gw.get("/updates").await?;
    assert_eq!(hidden.data()["components"][0]["update_available"], false);
    let settled =
        s.gw.post("/updates/check", json!({"component":"app"}))
            .await?;
    assert_eq!(settled.status, 200);
    let status_path = s.sandbox.data.join("updates/status.json");
    let before = std::fs::metadata(&status_path)?.modified()?;
    for _ in 0..3 {
        let _ = s.gw.get("/updates").await?;
    }
    assert_eq!(
        std::fs::metadata(&status_path)?.modified()?,
        before,
        "idle status reads wrote DATA"
    );
    let stable = json!({"component":"app", "version":"0.1.0", "channel":"stable",
        "staging_policy":"butler-data-updates", "activation_policy":"user-installs-app-package",
        "rollback_policy":"not-managed-by-butler"});
    std::fs::write(&manifest, json!({"artifacts":[stable]}).to_string())?;
    let next =
        s.gw.post("/updates/check", json!({"component":"app"}))
            .await?;
    assert_eq!(next.data()["components"][0]["available_version"], "0.1.0");
    assert_eq!(next.data()["components"][0]["update_available"], true);
    let command = s
        .agent
        .launch
        .command()
        .args(["config", "set", "update.previews", "true", "--json"])
        .output()?;
    assert!(command.status.success());
    s.restart().await?;
    assert_eq!(s.gw.settings().await?["update_previews"], true);
    let status = s
        .agent
        .launch
        .command()
        .args(["status", "--json"])
        .output()?;
    let status: serde_json::Value = serde_json::from_slice(&status.stdout)?;
    assert_eq!(status["data"]["update"]["previews"], true);
    s.finish().await
}

#[tokio::test]
async fn stable_install_can_receive_preview_then_newer_stable() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("UPDATE-STABLE")?.env("BUTLER_APP_VERSION", "0.1.0");
    let manifest = setup.sandbox.root.join("updates.json");
    let item = |version: &str| {
        json!({"component":"app", "version":version,
        "channel":if version.contains('-') {"preview"} else {"stable"},
        "staging_policy":"butler-data-updates", "activation_policy":"user-installs-app-package",
        "rollback_policy":"not-managed-by-butler"})
    };
    std::fs::write(
        &manifest,
        json!({"artifacts":[item("0.1.1-preview.9"), item("0.1.1-preview.10"), item("0.1.0")]})
            .to_string(),
    )?;
    let s = setup
        .env("BUTLER_APP_UPDATE_MANIFEST", manifest.to_string_lossy())
        .start()
        .await?;
    assert_eq!(
        s.gw.patch("/settings", json!({"update_previews":true}))
            .await?
            .status,
        200
    );
    let preview =
        s.gw.post("/updates/check", json!({"component":"app"}))
            .await?;
    assert_eq!(
        preview.data()["components"][0]["available_version"],
        "0.1.1-preview.10"
    );
    assert_eq!(preview.data()["components"][0]["update_available"], true);
    std::fs::write(
        &manifest,
        json!({"artifacts":[item("0.1.1-preview.99"), item("0.1.1")]}).to_string(),
    )?;
    let stable =
        s.gw.post("/updates/check", json!({"component":"app"}))
            .await?;
    assert_eq!(stable.data()["components"][0]["available_version"], "0.1.1");
    s.finish().await
}
