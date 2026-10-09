//! Complete idle observation; selected by the serial performance tier.
use super::*;

#[tokio::test]
async fn perf_hooks_no_config_idle_has_zero_writes_for_three_windows() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = setup("HOOK-IDLE")?.start().await?;
    // Startup completes before observing unchanged idle database versions.
    let (turn, _) = s.turn("general", "Settle startup.").await?;
    let app = sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let btcc = sqlite::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let version = |db: &rusqlite::Connection| {
        db.query_row("PRAGMA data_version", [], |r| r.get::<_, u64>(0))
            .unwrap()
    };
    // Delivered is visible before the retention owner folds its final events.
    // Wait for that durable receipt rather than counting its commit as idle I/O.
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let settled: bool = app.query_row(
            "SELECT EXISTS(SELECT 1 FROM app_terminal_turn_projections WHERE turn_id=?1 AND terminal_state='delivered') AND NOT EXISTS(SELECT 1 FROM app_terminal_turn_snapshot_state WHERE turn_id=?1)",
            [&turn], |row| row.get(0),
        )?;
        if settled {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "terminal retention did not settle"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let before = (version(&app), version(&btcc));
    for window in 0..3 {
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert!(!s.sandbox.data.join("hooks.json").exists());
        assert_eq!(
            (version(&app), version(&btcc)),
            before,
            "idle window {window}"
        );
        assert_eq!(
            api(&s, Method::GET, "/hooks/runs", None).await?.data(),
            &json!([])
        );
        eprintln!("HOOK-IDLE window={window}: hook writes=0, DB commits=0, runs=0");
    }
    drop((app, btcc));
    s.finish().await
}
