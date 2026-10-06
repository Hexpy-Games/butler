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

#[tokio::test]
async fn session_binding_mutations_finish_before_idle() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("COMPOSER-IDLE")?
        .cassette("TURN-01")
        .replay_only()
        .start()
        .await?;
    let prompt = "Write the numbers from one to twelve as English words, separated by single spaces, and nothing else.";
    let (_, turn) = s.turn("general", prompt).await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let path = s.sandbox.data.join("runtime/session-store.sqlite");
    let db =
        butler_platform::sqlite::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    let bindings: u64 = db
        .query_row("SELECT COUNT(*) FROM session_bindings", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert!(bindings >= 2, "the turn created its runtime binding");
    let version = || {
        db.query_row("PRAGMA data_version", [], |row| row.get::<_, u64>(0))
            .unwrap()
    };
    let before_version = version();
    let shm = path.with_extension("sqlite-shm");
    let before = std::fs::metadata(&shm).unwrap().modified().unwrap();
    let bytes = std::fs::read(&shm).unwrap();
    for _ in 0..9 {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        assert_eq!(version(), before_version, "zero idle session DB commits");
        assert_eq!(
            std::fs::metadata(&shm).unwrap().modified().unwrap(),
            before,
            "zero idle WAL-index writes"
        );
        assert_eq!(
            std::fs::read(&shm).unwrap(),
            bytes,
            "WAL-index remains complete"
        );
    }
    drop(db);
    s.finish().await
}
