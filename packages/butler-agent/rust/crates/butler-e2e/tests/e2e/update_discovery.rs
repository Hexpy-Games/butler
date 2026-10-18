//! Installed preview fixture: exercise the default release-list discovery,
//! not an explicit candidate manifest that bypasses the release cache.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

use butler_e2e::e2e::{
    HarnessError,
    scenario::{Fixture, Setup},
};
use serde_json::{Value, json};
use tokio::net::TcpListener;

struct Feed {
    api: String,
    published: Arc<AtomicU64>,
    lists: Arc<AtomicU64>,
    task: tokio::task::JoinHandle<()>,
}

impl Feed {
    async fn start() -> Result<Self, HarnessError> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let base = format!("http://{}", listener.local_addr()?);
        let api = format!("{base}/releases");
        let published = Arc::new(AtomicU64::new(6));
        let lists = Arc::new(AtomicU64::new(0));
        let (latest, hits) = (published.clone(), lists.clone());
        let app = axum::Router::new().fallback(move |uri: axum::http::Uri| {
            let (latest, hits, base) = (latest.clone(), hits.clone(), base.clone());
            async move {
                if uri.path() == "/releases" {
                    hits.fetch_add(1, Ordering::SeqCst);
                    let releases: Vec<_> = (6..=latest.load(Ordering::SeqCst))
                        .rev()
                        .map(|n| {
                            json!({"tag_name":format!("v0.1.0-preview.{n}"), "draft":false,
                            "prerelease":true, "assets":[{"name":"app-update-manifest.json",
                            "browser_download_url":format!("{base}/preview.{n}")}]})
                        })
                        .collect();
                    return axum::Json(json!(releases));
                }
                if uri.path() == "/releases/latest" {
                    return axum::Json(json!({"tag_name":"v0.0.9", "draft":false,
                        "prerelease":false, "assets":[{"name":"app-update-manifest.json",
                        "browser_download_url":format!("{base}/stable")}] }));
                }
                let version = if uri.path() == "/stable" {
                    "0.0.9"
                } else if uri.path().ends_with("preview.7") {
                    "0.1.0-preview.7"
                } else if uri.path().ends_with("preview.8") {
                    "0.1.0-preview.8"
                } else {
                    "0.1.0-preview.6"
                };
                axum::Json(json!({"artifacts":[{
                    "component":"app", "version":version,
                    "channel":if version.contains("preview") {"preview"} else {"stable"},
                    "platform":butler_platform::launcher::release_platform(),
                    "package_format":butler_platform::app_update::package_format(),
                    "staging_policy":"butler-data-updates",
                    "activation_policy":"user-installs-app-package",
                    "rollback_policy":"not-managed-by-butler"
                }]}))
            }
        });
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Ok(Self {
            api,
            published,
            lists,
            task,
        })
    }
}

impl Drop for Feed {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn assert_offer(view: &Value, current: &str, available: &str, offered: bool) {
    assert_eq!(view["components"].as_array().unwrap().len(), 1);
    let app = &view["components"][0];
    assert_eq!(app["component"], "app");
    assert_eq!(app["current_version"], current);
    assert_eq!(app["available_version"], available);
    assert_eq!(app["update_available"], offered);
    assert_eq!(app["check_state"], "ok");
    assert_eq!(
        app["platform"],
        butler_platform::launcher::release_platform()
    );
}

#[tokio::test]
async fn installed_preview_refresh_discovers_new_published_releases() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let feed = Feed::start().await?;
    let setup = Setup::new("UPDATE-DISCOVERY")?
        .fixture(Fixture::Empty)
        .env("BUTLER_APP_VERSION", "0.1.0-preview.6")
        .env("BUTLER_UPDATE_RELEASES_API", &feed.api);
    let mut s = setup.start().await?;
    assert_eq!(s.gw.settings().await?["update_previews"], true);
    let initial =
        s.gw.post("/updates/check", json!({"component":"app"}))
            .await?;
    assert_eq!(initial.status, 200, "{}", initial.text);
    assert_offer(initial.data(), "0.1.0-preview.6", "0.1.0-preview.6", false);
    assert!(
        feed.lists.load(Ordering::SeqCst) > 0,
        "fresh preview must query release list"
    );
    feed.published.store(7, Ordering::SeqCst);
    // Status remains cached until the user refreshes; ordinary reads do no network work.
    let before = feed.lists.load(Ordering::SeqCst);
    let cached = s.gw.get("/updates").await?;
    assert_offer(cached.data(), "0.1.0-preview.6", "0.1.0-preview.6", false);
    assert_eq!(feed.lists.load(Ordering::SeqCst), before);
    let refreshed =
        s.gw.post("/updates/check", json!({"component":"app"}))
            .await?;
    assert_offer(refreshed.data(), "0.1.0-preview.6", "0.1.0-preview.7", true);
    assert!(
        feed.lists.load(Ordering::SeqCst) > before,
        "refresh reused the old release URL"
    );
    s.gw.patch("/settings", json!({"update_previews":false}))
        .await?;
    let hidden =
        s.gw.post("/updates/check", json!({"component":"app"}))
            .await?;
    assert_offer(hidden.data(), "0.1.0-preview.6", "0.0.9", false);
    s.gw.patch("/settings", json!({"update_previews":true}))
        .await?;
    s.agent
        .launch
        .set_env("BUTLER_APP_VERSION", "0.1.0-preview.7");
    s.restart().await?;
    let installed =
        s.gw.post("/updates/check", json!({"component":"app"}))
            .await?;
    assert_offer(
        installed.data(),
        "0.1.0-preview.7",
        "0.1.0-preview.7",
        false,
    );
    feed.published.store(8, Ordering::SeqCst);
    let next =
        s.gw.post("/updates/check", json!({"component":"app"}))
            .await?;
    assert_offer(next.data(), "0.1.0-preview.7", "0.1.0-preview.8", true);
    s.finish().await
}
