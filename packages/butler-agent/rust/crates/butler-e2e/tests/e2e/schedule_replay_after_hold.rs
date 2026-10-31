//! A held schedule retains the latest occurrence without replaying its backlog.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "E2E assertions"
)]
use super::chats_initiated::support::{clock, runs, setup};
use butler_e2e::e2e::{HarnessError, scenario::Scenario};
use serde_json::{Value, json};
use std::time::Duration;

mod lifecycle;
mod manual;

async fn create(s: &Scenario, id: &str, timing: Value) -> Result<(), HarnessError> {
    let mut body = json!({"id":id,"title":"Held report","prompt_body":"Prepare a report.",
        "target_session_id":"general"});
    body.as_object_mut()
        .unwrap()
        .extend(timing.as_object().unwrap().clone());
    let r = s.gw.post("/automations", body).await?;
    assert_eq!(r.status, 201, "{}", r.text);
    Ok(())
}
async fn dispatch(s: &Scenario) -> Result<Value, HarnessError> {
    let r = s.gw.post("/automations/dispatch-due", json!({})).await?;
    assert_eq!(r.status, 202, "{}", r.text);
    Ok(r.data().clone())
}
async fn schedule(s: &Scenario, id: &str) -> Result<Value, HarnessError> {
    let r = s.gw.get(&format!("/automations/{id}")).await?;
    assert_eq!(r.status, 200, "{}", r.text);
    Ok(r.data()["automation"].clone())
}
async fn delivered(s: &Scenario, id: &str) -> Result<Vec<Value>, HarnessError> {
    let records = tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            let records = runs(s, id).await?;
            if !records.is_empty() && records.iter().all(|r| r["state"] == "succeeded") {
                return Ok::<_, HarnessError>(records);
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("held reports dispatched")?;
    for run in &records {
        let target = run["target_session_id"].as_str().unwrap();
        let turn =
            s.gw.wait_terminal(
                target,
                run["turn_id"].as_str().unwrap(),
                Duration::from_secs(90),
            )
            .await?;
        assert_eq!(turn["state"], "delivered", "{turn}");
    }
    Ok(records)
}
async fn reports(s: &Scenario, chat: &str, id: &str) -> Result<Vec<Value>, HarnessError> {
    Ok(s.gw
        .messages(chat)
        .await?
        .into_iter()
        .filter(|m| {
            m["role"] == "assistant"
                && m["status"] == "delivered"
                && m["initiated"]["automation_id"] == id
        })
        .collect())
}
fn interval() -> Value {
    json!({"schedule_type":"interval","interval_seconds":3600,"start_at":"2026-10-27T04:30:00.000Z"})
}

#[tokio::test]
async fn hourly_hold_replays_only_latest_and_later_occurrence_does_not_freeze()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, address) = setup("HOLD-REPLAY", "2026-10-27T04:29:00.000Z").await?;
    create(&s, "hourly", interval()).await?;
    for hour in [4, 5, 6] {
        clock(&address, &format!("2026-10-27T{hour:02}:31:00.000Z")).await?;
        dispatch(&s).await?;
        assert_eq!(
            schedule(&s, "hourly").await?["next_run_at"],
            format!("2026-10-27T{:02}:30:00.000Z", hour + 1)
        );
    }
    let held = runs(&s, "hourly").await?;
    assert!(held.iter().all(|r| r["state"] == "queued"), "{held:?}");
    assert!(reports(&s, "general", "hourly").await?.is_empty());
    s.agent
        .launch
        .set_env("BUTLER_E2E_APP_NOW", "2026-10-27T06:31:00.000Z");
    s.restart().await?;
    dispatch(&s).await?;
    assert_eq!(runs(&s, "hourly").await?, held);
    clock(&address, "2026-10-27T07:00:00.000Z").await?;
    let records = delivered(&s, "hourly").await?;
    let replies = reports(&s, "general", "hourly").await?;
    eprintln!(
        "HOLD-REPLAY held_runs={} dispatched_runs={} replies={} scheduled_at={:?}",
        held.len(),
        records.len(),
        replies.len(),
        records
            .iter()
            .map(|r| &r["scheduled_at"])
            .collect::<Vec<_>>()
    );
    assert_eq!(records.len(), 1, "held backlog replayed: {records:?}");
    assert_eq!(replies.len(), 1, "{replies:?}");
    assert_eq!(records[0]["scheduled_at"], "2026-10-27T06:30:00.000Z");
    assert_eq!(records[0]["id"], held[0]["id"]);
    assert!(
        s.provider()?
            .requests()
            .iter()
            .any(|r| r.to_string().contains("2026-10-27T06:30:00.000Z"))
    );
    // Clock advance alone: no dispatch request, settings edit, or OS wake.
    clock(&address, "2026-10-27T07:30:00.000Z").await?;
    tokio::time::timeout(Duration::from_secs(90), async {
        while runs(&s, "hourly").await?.len() < 2 {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        Ok::<_, HarnessError>(())
    })
    .await
    .expect("later occurrence fires without unrelated wake")?;
    let later = delivered(&s, "hourly").await?;
    assert_eq!(later.len(), 2);
    assert_eq!(later[0]["scheduled_at"], "2026-10-27T07:30:00.000Z");
    assert_eq!(reports(&s, "general", "hourly").await?.len(), 2);
    assert_eq!(
        schedule(&s, "hourly").await?["next_run_at"],
        "2026-10-27T08:30:00.000Z"
    );
    s.finish().await
}
