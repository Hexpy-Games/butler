//! Headless configuration stays an operator setting, outside the App UI API.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use super::support::{admin, browser_processes, call, publish, setup};
use butler_e2e::e2e::HarnessError;
use reqwest::Method;
use serde_json::{Value, json};

#[tokio::test]
async fn settings_rejects_the_removed_browser_toggle() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = setup("BROWSER-HEADLESS-SETTINGS")?
        .env("BUTLER_BROWSER_APP", "off")
        .env("BUTLER_BROWSER_HEADLESS", "off")
        .start()
        .await?;
    let admin = admin(&s);
    let reply = admin
        .send(
            Method::PATCH,
            "/settings",
            Some(json!({"security":{"headless_browser":true}})),
            &[],
        )
        .await?;
    assert_eq!(reply.status, 400, "{}", reply.text);
    let view = admin.send(Method::GET, "/security", None, &[]).await?;
    assert!(
        view.data().get("headless_browser").is_none(),
        "{}",
        view.text
    );
    assert!(
        view.data().get("headless_browser_app").is_none(),
        "{}",
        view.text
    );
    let opened = call(
        &admin,
        "general",
        "tab.open",
        &Value::Null,
        json!({"url":"https://example.test"}),
    )
    .await?;
    assert_eq!(opened["reason"], "no_browser", "{opened}");
    assert!(browser_processes(&s.sandbox.data.to_string_lossy()).is_empty());
    s.finish().await
}

#[tokio::test]
async fn browser_config_and_environment_remain_operator_controls() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("BROWSER-HEADLESS-CONFIG")?
        .env("BUTLER_BROWSER_HEADLESS", "")
        .env("BUTLER_BROWSER_APP", "off")
        .env("BUTLER_BROWSER_DOWNLOAD_BASE", "http://127.0.0.1:9/");
    let path = setup.sandbox.data.join("gateways/app.json");
    std::fs::create_dir_all(path.parent().unwrap())?;
    let settings = json!({"config":{"headlessBrowser":false}});
    std::fs::write(&path, serde_json::to_vec(&settings)?)?;
    let mut s = setup.start().await?;
    let opened = call(
        &admin(&s),
        "general",
        "tab.open",
        &Value::Null,
        json!({"url":"https://example.test"}),
    )
    .await?;
    assert_eq!(opened["reason"], "no_browser", "{opened}");
    s.agent.launch.set_env("BUTLER_BROWSER_HEADLESS", "on");
    s.restart().await?;
    let url = publish(&s).await?;
    let opened = call(
        &admin(&s),
        "general",
        "tab.open",
        &Value::Null,
        json!({"url":url}),
    )
    .await?;
    assert_eq!(opened["reason"], "browser_download_failed", "{opened}");
    let persisted: Value = serde_json::from_slice(&std::fs::read(path)?)?;
    assert_eq!(persisted["config"]["headlessBrowser"], false);
    s.finish().await
}
