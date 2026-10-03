//! Quit/update decisions at owner scale exclude terminal history and jobs.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use butler_platform::sqlite;
use std::time::{Duration, Instant};

#[tokio::test]
async fn user_work_ignores_failed_queues_and_owner_scale_history() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("UPDATE-USER-WORK")?.start().await?;
    s.agent.terminate().await?;
    let db = sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))
        .map_err(|e| HarnessError(e.to_string()))?;
    db.execute_batch(
        "BEGIN;
         WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<600)
         INSERT INTO chats(id,title,kind,created_at,updated_at)
         SELECT 'history-'||x,'History','chat','2026-10-01','2026-10-01' FROM n;
         WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<300000)
         INSERT INTO turns(id,chat_id,state,safe_status_label,created_at,updated_at)
         SELECT 'ended-'||x,'history-'||(1+x%600),
                CASE WHEN x%2=0 THEN 'failed' ELSE 'runtime_fault' END,
                'Ended','2026-10-01','2026-10-01' FROM n;
         INSERT INTO session_queued_messages(id,chat_id,text,controls_json,attachments_json,
                    state,safe_error_code,created_at,updated_at)
         VALUES('failed-history','history-1','Retained input','{}','[]','failed',
                'app_turn_queue_failed','2026-10-01','2026-10-01');
         COMMIT;",
    )
    .map_err(|e| HarnessError(e.to_string()))?;
    drop(db);
    s.gw = s.agent.start_again().await?;
    let started = Instant::now();
    let view = s.gw.get("/user-work").await?.data().clone();
    let elapsed = started.elapsed();
    assert_eq!(view["classification"], "no_active_work", "{view}");
    assert_eq!(view["active_turn_count"], 0);
    assert_eq!(view["queued_message_count"], 0);
    assert_eq!(view["delegated_work_present"], false);
    assert_eq!(view["raw_text_included"], false);
    butler_e2e::assert_wall_clock_budget!(
        elapsed,
        Duration::from_secs(1),
        "user-work waited on history"
    );
    eprintln!("user-work: 600 chats / 300000 terminal turns / retained failed queue: {elapsed:?}");
    s.finish().await
}
