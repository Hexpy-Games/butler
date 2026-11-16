//! A reused headless profile keeps no site state between conversations or runs.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use super::{
    support::{admin, call, hidden_app, open, publish_as, selected, setup, shell, state_root},
    text,
};
use butler_e2e::e2e::{HarnessError, security::AdminClient};
use serde_json::json;

/// Reports what the page found, and only then stores a cookie and a localStorage item.
pub(crate) const FIXTURE: &str = r#"<!doctype html><meta charset="utf-8"><title>Profile fixture</title>
<main><p id="found"></p></main>
<script>
const had = document.cookie !== "" || localStorage.getItem("k") !== null;
document.getElementById("found").textContent = had ? "found: kept" : "found: none";
document.cookie = "k=v; max-age=86400; path=/";
localStorage.setItem("k", "v");
</script>"#;

#[tokio::test]
async fn a_reused_profile_keeps_no_site_state() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(selected(), "BUTLER_E2E_BROWSER_BACKEND=headless not set");
    butler_e2e::skip_unless!(
        !hidden_app(),
        "the hidden App host keeps its own throwaway profiles"
    );
    let mut s = setup("BROWSER-HEADLESS-PROFILE")?.start().await?;
    let (id, url) = publish_as(&s, "Publish profile fixture").await?;
    // Opens the page and returns its tab and what the page found.
    let visit = |admin: AdminClient, conversation: &'static str, url: String| async move {
        let opened = open(&admin, conversation, &url).await?;
        assert_eq!(opened["status"], "ok", "{opened}");
        let page = call(
            &admin,
            conversation,
            "tab.observe",
            &opened["tab"],
            json!({"settle":true}),
        )
        .await?;
        Ok::<_, HarnessError>((opened["tab"].clone(), text(&page)))
    };
    let (a, seen) = visit(admin(&s), "general", url.clone()).await?;
    assert!(seen.contains("found: none"), "{seen}");
    // A second tab of the same conversation shares what the first stored.
    let (b, seen) = visit(admin(&s), "general", url.clone()).await?;
    assert!(seen.contains("found: kept"), "{seen}");
    // Another conversation never sees it.
    let (c, seen) = visit(admin(&s), "other", url.clone()).await?;
    assert!(seen.contains("found: none"), "{seen}");
    for (conversation, tab) in [("general", a), ("general", b), ("other", c)] {
        call(&admin(&s), conversation, "tab.close", &tab, json!({})).await?;
    }
    // The shell keeps its profile in the App's own folder, which a restart does not model.
    if shell() {
        return s.finish().await;
    }
    s.restart().await?;
    let view = s.gw.get(&format!("/outputs/{id}/view")).await?;
    let after = view.data()["url"].as_str().unwrap().to_owned();
    assert_eq!(
        url::Url::parse(&url).unwrap().origin(),
        url::Url::parse(&after).unwrap().origin(),
        "the fixture keeps its origin across the restart"
    );
    assert!(state_root(&s.sandbox.data).join("profile").is_dir());
    // A lock left by a killed browser under another hostname must not block the next start.
    if butler_platform::command_sandbox::POSIX_SHELL {
        let lock = state_root(&s.sandbox.data).join("profile/SingletonLock");
        let _ = std::fs::remove_file(&lock);
        butler_platform::secure_fs::symlink(std::path::Path::new("otherhost-99999"), &lock)?;
    }
    let (tab, seen) = visit(admin(&s), "general", after).await?;
    assert!(seen.contains("found: none"), "{seen}");
    call(&admin(&s), "general", "tab.close", &tab, json!({})).await?;
    s.finish().await
}
