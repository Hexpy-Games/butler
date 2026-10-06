//! Composer appearance preference through the native settings API (stub).
#![allow(clippy::unwrap_used, reason = "test assertions")]

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::events::LiveEvents;
use butler_e2e::e2e::scenario::Setup;
use rusqlite::Connection;
use serde_json::json;
use std::time::Duration;

#[tokio::test]
async fn composer_fold_persists_and_publishes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("COMPOSER-FOLD")?.start().await?;
    assert_eq!(s.gw.settings().await?["collapse_message_box"], true);
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    let invalid =
        s.gw.patch("/settings", json!({"collapse_message_box": "false"}))
            .await?;
    assert_eq!(invalid.status, 400);
    let saved =
        s.gw.patch("/settings", json!({"collapse_message_box": false}))
            .await?;
    assert_eq!(saved.status, 200, "{}", saved.text);
    assert_eq!(saved.data()["collapse_message_box"], false);
    live.wait_for(Duration::from_secs(10), |event| {
        event["type"] == "settings.updated"
            && event["payload"]["settings"]["collapse_message_box"] == false
    })
    .await?;
    let db = Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let stored = || {
        db.query_row(
            "SELECT value_json, updated_at FROM app_settings WHERE key='settings'",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
    };
    let before = stored()?;
    let events = s.gw.events_since(0).await?;
    let unchanged =
        s.gw.patch("/settings", json!({"collapse_message_box": false}))
            .await?;
    assert_eq!(unchanged.status, 200, "{}", unchanged.text);
    assert_eq!(stored()?, before, "Unchanged toggle rewrote settings");
    assert_eq!(
        s.gw.events_since(0).await?,
        events,
        "Unchanged toggle wrote events"
    );
    drop(db);
    s.restart().await?;
    assert_eq!(s.gw.settings().await?["collapse_message_box"], false);
    let saved =
        s.gw.patch("/settings", json!({"collapse_message_box": true}))
            .await?;
    assert_eq!(saved.status, 200, "{}", saved.text);
    s.restart().await?;
    assert_eq!(s.gw.settings().await?["collapse_message_box"], true);
    s.finish().await
}
