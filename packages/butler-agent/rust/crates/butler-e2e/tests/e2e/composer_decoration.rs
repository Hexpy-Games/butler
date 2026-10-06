//! Composer decoration settings through the public gateway, including restart.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]

use butler_e2e::e2e::{HarnessError, scenario::Setup};
use serde_json::json;

#[tokio::test]
async fn composer_decoration_settings_are_validated_and_durable() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("COMPOSER-DECORATION")?.start().await?;
    let defaults = json!({"theme": "none", "character": true});
    assert_eq!(s.gw.settings().await?["composer_decoration"], defaults);
    for invalid in [
        json!({"theme":"unknown"}),
        json!({"character":1}),
        json!({"extra":true}),
    ] {
        let reply =
            s.gw.patch("/settings", json!({"composer_decoration":invalid}))
                .await?;
        assert_eq!(reply.status, 400, "{}", reply.text);
        assert_eq!(s.gw.settings().await?["composer_decoration"], defaults);
    }
    for patch in [
        json!({"theme":"shoreline"}),
        json!({"theme":"none"}),
        json!({"theme":"cherry"}),
        json!({"character":false}),
    ] {
        let reply =
            s.gw.patch("/settings", json!({"composer_decoration":patch}))
                .await?;
        assert_eq!(reply.status, 200, "{}", reply.text);
    }
    let chosen = json!({"theme":"cherry", "character":false});
    assert_eq!(s.gw.settings().await?["composer_decoration"], chosen);
    let db = butler_platform::sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))
        .unwrap();
    let version = || {
        db.query_row("PRAGMA data_version", [], |row| row.get::<_, u64>(0))
            .unwrap()
    };
    let before = version();
    let repeated =
        s.gw.patch("/settings", json!({"composer_decoration":chosen}))
            .await?;
    assert_eq!(repeated.status, 200, "{}", repeated.text);
    assert_eq!(
        version(),
        before,
        "unchanged settings perform zero database writes"
    );
    drop(db);
    s.restart().await?;
    assert_eq!(s.gw.settings().await?["composer_decoration"], chosen);
    s.finish().await
}
