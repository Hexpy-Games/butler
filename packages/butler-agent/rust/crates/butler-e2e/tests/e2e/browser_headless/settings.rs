//! Settings → Security turns Butler's own browser on and off while running,
//! and the choice survives a restart (`headlessBrowser` in the App settings).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use super::support::{admin, call, open, publish, selected, setup};
use butler_e2e::e2e::{HarnessError, security::AdminClient};
use reqwest::Method;
use serde_json::{Value, json};

async fn toggle(admin: &AdminClient, enabled: bool) -> Result<(), HarnessError> {
    let reply = admin
        .send(
            Method::PATCH,
            "/settings",
            Some(json!({"security":{"headless_browser":enabled}})),
            &[],
        )
        .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let view = admin.send(Method::GET, "/security", None, &[]).await?;
    assert_eq!(
        view.body["data"]["headless_browser"], enabled,
        "{}",
        view.text
    );
    Ok(())
}

#[tokio::test]
async fn settings_toggle_turns_the_headless_browser_on_and_off() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(selected(), "BUTLER_E2E_BROWSER_BACKEND=headless not set");
    let s = setup("BROWSER-HEADLESS-SETTINGS")?
        .env("BUTLER_BROWSER_HEADLESS", "off")
        .start()
        .await?;
    let admin = admin(&s);
    let url = publish(&s).await?;
    let off = call(
        &admin,
        "general",
        "tab.open",
        &Value::Null,
        json!({"url":url}),
    )
    .await?;
    assert_eq!(off["reason"], "no_browser", "{off}");

    toggle(&admin, true).await?;
    let settings: Value =
        serde_json::from_slice(&std::fs::read(s.sandbox.data.join("gateways/app.json"))?)?;
    assert_eq!(settings["config"]["headlessBrowser"], true, "{settings}");
    let opened = open(&admin, "general", &url).await?;
    assert_eq!(opened["status"], "ok", "{opened}");

    toggle(&admin, false).await?;
    let listed = call(&admin, "general", "tabs.list", &Value::Null, json!({})).await?;
    assert!(
        listed["tabs"].as_array().is_none_or(Vec::is_empty),
        "turning it off closes its tabs: {listed}"
    );
    let again = call(
        &admin,
        "general",
        "tab.open",
        &Value::Null,
        json!({"url":url}),
    )
    .await?;
    assert_eq!(again["reason"], "no_browser", "{again}");
    assert_eq!(
        super::support::browser_processes(&s.sandbox.data.to_string_lossy()),
        Vec::<String>::new(),
        "turning it off ends the process tree"
    );
    s.finish().await
}
