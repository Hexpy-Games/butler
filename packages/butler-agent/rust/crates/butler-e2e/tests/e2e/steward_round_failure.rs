//! A surfaced report-round failure through the actual steward runtime.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test assertions")]
use super::steward_presentation::{setup, stub};
use butler_e2e::e2e::HarnessError;
use std::{sync::atomic::Ordering, time::{Duration, Instant}};

#[tokio::test]
async fn steward_report_round_failure_settles_work_and_graph() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    script.fail_report.store(true, Ordering::SeqCst);
    script.release.notify_one();
    let setup = setup("STEWARD-REPORT-FAILURE", &url)?;
    for name in ["a.txt", "b.txt"] {
        std::fs::write(setup.sandbox.data.join(name), name)?;
    }
    *script.workspace.lock().unwrap() = setup.sandbox.data.display().to_string();
    let s = setup.start().await?;
    s.turn("general", stub::OWNER).await?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let view = s.gw.get("/session-view?session_id=general").await?;
        let child = &view.data()["steward_children"][0];
        if child["result"].is_object() {
            println!("Report failure result: {child}");
            let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
            let facts: (String, String, String, String) = db.query_row(
                "SELECT t.semantic_state,w.status,e.error_code,e.failure_disposition FROM btcc_turns t JOIN btcc_guided_works w ON w.session_id=t.session_id JOIN btcc_model_route_events e ON e.turn_id=t.turn_id WHERE t.session_id=?1 AND e.event_type='model.attempt.failed' ORDER BY e.rowid DESC LIMIT 1",
                [child["session_id"].as_str().unwrap()],
                |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
            println!("Failure path facts (turn, Work, code, disposition): {facts:?}");
            assert_eq!(facts.0, "delivered", "Err path would leave the turn admitted");
            assert_eq!(facts.2, "provider_unknown_error");
            assert_eq!(facts.3, "surface");
            break;
        }
        assert!(Instant::now() < deadline, "Failure path reproduction: {view:?}\n{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    s.finish().await?;
    server.abort();
    Ok(())
}
