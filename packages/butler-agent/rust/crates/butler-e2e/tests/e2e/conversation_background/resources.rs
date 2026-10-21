//! Settings mutation and history latency measured through HTTP.
use super::*;
use butler_platform::{process_control::usage, sqlite};
use std::time::{Duration, Instant};

#[tokio::test]
async fn cbg_07_one_settings_write_and_zero_idle_bytes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("CBG-07")?
        .env("BUTLER_E2E_IDLE_PROBE", "1")
        .start()
        .await?;
    let db = sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite")).unwrap();
    db.execute_batch(
        "CREATE TABLE cbg_writes(n INTEGER NOT NULL); INSERT INTO cbg_writes VALUES(0);
        CREATE TRIGGER cbg_write_count AFTER UPDATE ON app_settings WHEN NEW.key='settings'
        BEGIN UPDATE cbg_writes SET n=n+1; END;",
    )
    .unwrap();
    let count = || {
        db.query_row("SELECT n FROM cbg_writes", [], |row| row.get::<_, u64>(0))
            .unwrap()
    };
    let patch = json!({"conversation_background":{"overlay":45}});
    let reply = s.gw.patch("/settings", patch.clone()).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert_eq!(
        reply.data()["conversation_background"],
        json!({"source":riso(),"overlay":45})
    );
    assert_eq!(count(), 1, "exactly one settings row update per PATCH");
    let repeated = s.gw.patch("/settings", patch).await?;
    assert_eq!(repeated.status, 200, "{}", repeated.text);
    assert_eq!(count(), 1, "an unchanged PATCH has zero writes");
    drop(db);
    let mut watch =
        super::super::idle_resources::writes::Watch::open_after_quiet(&s.sandbox.data).await?;
    let pid = s.agent.pid().unwrap();
    let before = usage::sample(pid)?.expect("process write counters available");
    tokio::time::sleep(Duration::from_secs(60)).await;
    let after = usage::sample(pid)?.expect("process write counters available");
    watch.assert_unchanged();
    let bytes = after.write_bytes - before.write_bytes;
    eprintln!("CBG-07 settings_writes=1 idle_seconds=60 process_write_bytes={bytes}");
    assert_eq!(bytes, 0, "zero process writes during idle");
    assert_eq!(
        s.gw.settings().await?["conversation_background"],
        json!({"source":riso(),"overlay":45})
    );
    s.finish().await
}

#[tokio::test]
async fn cbg_08_history_settings_get_patch_p95() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("CBG-08")?.start().await?;
    let path = s.sandbox.data.join("app-server/butler-client.sqlite");
    let db = sqlite::open(&path).unwrap();
    super::super::app_retention::seed::seed_history(&db, 64);
    db.execute_batch(
        "BEGIN;
        WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<7)
        INSERT INTO chats(id,title,kind,pinned,archived,created_at,updated_at)
        SELECT 'cbg-c'||i,'Chat', 'chat',0,0,'2026-01-01','2026-01-01' FROM n;
        WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<47)
        INSERT INTO events(type,turn_id,payload_json,created_at)
        SELECT 'cbg.fixture','',json_object('text',hex(zeroblob(64))),'2026-01-01' FROM n;
        COMMIT;",
    )
    .unwrap();
    let chats: u64 = db
        .query_row(
            "SELECT COUNT(*) FROM chats WHERE id LIKE 'perf-c%' OR id LIKE 'cbg-c%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let events: u64 = db.query_row("SELECT COUNT(*) FROM events WHERE created_at='2026-01-01' OR created_at='2026-01-01T00:00:00.000Z'", [], |r| r.get(0)).unwrap();
    assert_eq!((chats, events), (16, 380));
    let plans: Vec<String> = db
        .prepare("EXPLAIN QUERY PLAN SELECT value_json FROM app_settings WHERE key='settings'")
        .unwrap()
        .query_map([], |row| row.get(3))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert!(
        plans.iter().all(|p| !p.contains("SCAN")),
        "indexed settings row: {plans:?}"
    );
    let bytes = std::fs::metadata(&path)?.len()
        + std::fs::metadata(path.with_extension("sqlite-wal"))?.len();
    drop(db);
    let original = s.gw.settings().await?;
    let mut gets = Vec::new();
    let mut patches = Vec::new();
    for i in 0..40 {
        let overlay = if i % 2 == 0 { 40 } else { 45 };
        let start = Instant::now();
        let reply =
            s.gw.patch(
                "/settings",
                json!({"conversation_background":{"overlay":overlay}}),
            )
            .await?;
        patches.push(start.elapsed().as_secs_f64() * 1000.);
        assert_eq!(reply.status, 200, "{}", reply.text);
        assert_eq!(
            reply.data()["conversation_background"],
            json!({"source":riso(),"overlay":overlay})
        );
        assert_eq!(reply.data()["wallpaper"], original["wallpaper"]);
        let start = Instant::now();
        let settings = s.gw.settings().await?;
        gets.push(start.elapsed().as_secs_f64() * 1000.);
        assert_eq!(
            settings,
            *reply.data(),
            "complete and latest settings projection"
        );
        assert_eq!(
            settings.as_object().unwrap().len(),
            original.as_object().unwrap().len()
        );
    }
    gets.sort_by(f64::total_cmp);
    patches.sort_by(f64::total_cmp);
    eprintln!(
        "CBG-08 app_bytes={bytes} chats={chats} events={events} samples=40 GET_p95_ms={:.3} PATCH_p95_ms={:.3}",
        gets[37], patches[37]
    );
    s.finish().await
}
