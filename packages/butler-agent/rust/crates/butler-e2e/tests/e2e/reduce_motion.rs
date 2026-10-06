//! Appearance motion override: default, strict input, persistence and live events (stub).
#![allow(clippy::unwrap_used, reason = "test assertions")]

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::events::LiveEvents;
use butler_e2e::e2e::scenario::Setup;
use serde_json::json;
use std::time::Duration;

#[tokio::test]
async fn reduce_motion_persists_and_publishes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("REDUCE-MOTION")?.start().await?;
    assert_eq!(s.gw.settings().await?["reduce_motion"], false);
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    let invalid =
        s.gw.patch("/settings", json!({"reduce_motion": "true"}))
            .await?;
    assert_eq!(invalid.status, 400);
    let saved =
        s.gw.patch("/settings", json!({"reduce_motion": true}))
            .await?;
    assert_eq!(saved.status, 200, "{}", saved.text);
    assert_eq!(saved.data()["reduce_motion"], true);
    live.wait_for(Duration::from_secs(10), |event| {
        event["type"] == "settings.updated" && event["payload"]["settings"]["reduce_motion"] == true
    })
    .await?;
    s.restart().await?;
    assert_eq!(s.gw.settings().await?["reduce_motion"], true);
    let saved =
        s.gw.patch("/settings", json!({"reduce_motion": false}))
            .await?;
    assert_eq!(saved.status, 200, "{}", saved.text);
    s.restart().await?;
    assert_eq!(s.gw.settings().await?["reduce_motion"], false);
    s.finish().await
}
