//! Retired App SQLite owners resume concurrent work and preserve committed data.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]

use butler_e2e::e2e::{
    HarnessError,
    scenario::{Scenario, Setup},
};
use serde_json::{Value, json};
use std::time::Duration;

#[tokio::test]
async fn idle_storage_resumes_complete_concurrent_writes_and_reads() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("STORAGE-IDLE")?.start().await?;
    let mut expected = Vec::new();
    for round in 0..2 {
        // Both the connection and its execution thread retire after ten idle
        // seconds. Every new request must retain fresh transaction semantics.
        tokio::time::sleep(Duration::from_secs(11)).await;
        let replies = futures_util::future::join_all((0..8).map(|index| {
            let gateway = &s.gw;
            async move {
                gateway
                    .post(
                        "/automations",
                        json!({
                            "title": format!("Scheduled {round}-{index}"),
                            "prompt_body": format!("Complete request {round}-{index}"),
                            "target_session_id": "general",
                            "schedule_type": "interval",
                            "interval_seconds": 86400,
                            "start_at": "9999-12-30T07:00:00.000Z"
                        }),
                    )
                    .await
            }
        }))
        .await;
        for reply in replies {
            let reply = reply?;
            assert_eq!(reply.status, 201, "{}", reply.text);
            expected.push(reply.data()["automation"].clone());
        }
        assert_complete(&s, &expected).await?;
    }
    s.agent.terminate().await?;
    s.gw = s.agent.start_again().await?;
    assert_complete(&s, &expected).await?;
    s.finish().await
}

async fn assert_complete(s: &Scenario, expected: &[Value]) -> Result<(), HarnessError> {
    let reply = s.gw.get("/automations").await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let rows = reply.data()["automations"].as_array().unwrap();
    assert_eq!(rows.len(), expected.len());
    for saved in expected {
        let row = rows.iter().find(|row| row["id"] == saved["id"]).unwrap();
        for field in ["title", "target_session_id", "next_run_at"] {
            assert_eq!(row[field], saved[field], "{field}: {row}");
        }
        assert_eq!(row["run_count"], 0);
        let id = saved["id"].as_str().unwrap();
        let detail = s.gw.get(&format!("/automations/{id}")).await?;
        assert_eq!(detail.status, 200, "{}", detail.text);
        assert_eq!(&detail.data()["automation"], saved);
    }
    Ok(())
}
