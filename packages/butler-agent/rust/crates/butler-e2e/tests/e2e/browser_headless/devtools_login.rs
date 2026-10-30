//! On a real browser: which cookies read as a sign-in, a password going in by
//! Butler's hand, and a page whose script has hung still answering for its
//! console and network.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test assertions")]
use super::support::{admin, call, node, open, publish_as, selected, setup};
use butler_e2e::e2e::{HarnessError, security::AdminClient};
use serde_json::{Value, json};
use std::time::Duration;

/// Sets the cookie its address names.
pub(super) const NAMED_COOKIE_PAGE: &str = r#"<!doctype html><meta charset="utf-8"><title>Cookie fixture</title><p>page</p>
<script>document.cookie = decodeURIComponent(location.hash.slice(1)) + "=1; path=/";</script>"#;

pub(super) const FILL_PAGE: &str = r#"<!doctype html><meta charset="utf-8"><title>Fill fixture</title>
<input aria-label="Search" name="q"><input aria-label="Password" name="field-two" type="text">"#;

pub(super) const HUNG_PAGE: &str = r#"<!doctype html><meta charset="utf-8"><title>Hung fixture</title><p>page</p>
<script>console.error("before the hang");setTimeout(() => { for (;;) {} }, 300);</script>"#;

async fn masked_within(
    admin: &AdminClient,
    session: &str,
    tab: &Value,
    wanted: bool,
) -> Result<Value, HarnessError> {
    let mut place = Value::Null;
    for _ in 0..30 {
        place = call(admin, session, "tab.devtools_place", tab, json!({})).await?;
        if place["masked"] == wanted {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Ok(place)
}

#[tokio::test]
async fn the_same_cookie_names_read_as_a_sign_in_on_both_browsers() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    if !selected() {
        return Ok(());
    }
    let s = setup("HEADLESS-DEVTOOLS-NAMES")?.start().await?;
    let admin = admin(&s);
    let (_, url) = publish_as(&s, "Publish devtools named cookie").await?;
    let cases = [
        ("session", true),
        ("PHPSESSID", true),
        ("myKey", true),
        ("wordpress_logged_in_abc", true),
        ("_ga", false),
    ];
    for (index, (name, wanted)) in cases.iter().enumerate() {
        let session = format!("cookie-{index}");
        let opened = open(&admin, &session, &format!("{url}#{name}")).await?;
        assert_eq!(opened["status"], "ok", "{opened}");
        let place = masked_within(&admin, &session, &opened["tab"], *wanted).await?;
        assert_eq!(place["masked"], *wanted, "{name}: {place}");
        // A negative result is only worth something once the cookie is in.
        tokio::time::sleep(Duration::from_millis(300)).await;
        let settled = call(
            &admin,
            &session,
            "tab.devtools_place",
            &opened["tab"],
            json!({}),
        )
        .await?;
        assert_eq!(settled["masked"], *wanted, "{name}: {settled}");
    }
    s.finish().await
}

#[tokio::test]
async fn a_password_filled_by_butler_reads_as_a_sign_in() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    if !selected() {
        return Ok(());
    }
    let s = setup("HEADLESS-DEVTOOLS-FILL")?.start().await?;
    let admin = admin(&s);
    let (_, url) = publish_as(&s, "Publish devtools fill").await?;
    let opened = open(&admin, "general", &url).await?;
    let tab = opened["tab"].clone();
    let fill = |name: &'static str| {
        let (admin, tab) = (&admin, &tab);
        async move {
            let observed = call(admin, "general", "tab.observe", tab, json!({})).await?;
            let target = node(&observed, "textbox", name)["ref"].clone();
            let steps = json!([{"action":"fill","ref":target,"value":"typed"}]);
            let prepare = json!({"observation":observed["obs"],"steps":steps});
            let prepared = call(admin, "general", "tab.prepare", tab, prepare).await?;
            let args = json!({"observation":observed["obs"],"steps":steps,"prepared_steps":prepared["steps"]});
            call(admin, "general", "tab.act", tab, args).await
        }
    };
    let acted = fill("Search").await?;
    assert_eq!(acted["status"], "ok", "{acted}");
    let place = call(&admin, "general", "tab.devtools_place", &tab, json!({})).await?;
    assert_eq!(place["masked"], false, "{place}");
    let acted = fill("Password").await?;
    assert_eq!(acted["status"], "ok", "{acted}");
    let place = masked_within(&admin, "general", &tab, true).await?;
    assert_eq!(place["masked"], true, "{place}");
    s.finish().await
}

#[tokio::test]
async fn a_hung_page_still_answers_for_its_console_and_network() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    if !selected() {
        return Ok(());
    }
    let s = setup("HEADLESS-DEVTOOLS-HUNG")?.start().await?;
    let admin = admin(&s);
    let (_, url) = publish_as(&s, "Publish devtools hung").await?;
    let opened = open(&admin, "general", &url).await?;
    let tab = opened["tab"].clone();
    tokio::time::sleep(Duration::from_millis(800)).await;
    let expect = json!({"place":"local","site":""});
    let place = call(
        &admin,
        "general",
        "tab.devtools_place",
        &tab,
        json!({"read":"console"}),
    )
    .await?;
    assert_eq!(place["status"], "ok", "{place}");
    let args = json!({"read":"console","expect":expect});
    let console = call(&admin, "general", "tab.devtools", &tab, args).await?;
    assert_eq!(console["status"], "ok", "{console}");
    assert!(
        console["untrusted_content"]["entries"]
            .to_string()
            .contains("before the hang"),
        "{console}"
    );
    let args = json!({"read":"network","expect":expect});
    let network = call(&admin, "general", "tab.devtools", &tab, args).await?;
    assert_eq!(network["status"], "ok", "{network}");
    s.finish().await
}
