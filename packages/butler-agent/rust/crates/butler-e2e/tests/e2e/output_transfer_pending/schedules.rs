use super::*;
use butler_platform::process_control::usage;
use std::time::Duration;

const DUE: &str = "2026-10-27T11:00:00.000Z";

async fn runs(s: &Scenario) -> Result<Vec<serde_json::Value>, HarnessError> {
    let r = s.gw.get("/automations/held/runs").await?;
    assert_eq!(r.status, 200, "{r:?}");
    Ok(r.data()["runs"].as_array().unwrap().clone())
}
async fn dispatch(s: &Scenario) -> Result<(), HarnessError> {
    let r = s.gw.post("/automations/dispatch-due", json!({})).await?;
    assert_eq!(r.status, 202, "{r:?}");
    Ok(())
}
async fn assert_held(s: &Scenario) -> Result<(), HarnessError> {
    let records = runs(s).await?;
    assert_eq!(records.len(), 1, "{records:?}");
    assert_eq!(records[0]["state"], "queued", "{records:?}");
    assert!(records[0]["turn_id"].is_null(), "{records:?}");
    assert!(records[0]["safe_error_code"].is_null(), "{records:?}");
    let r = s.gw.get("/automations/held").await?;
    assert_eq!(r.data()["automation"]["state"], "enabled", "{r:?}");
    assert_eq!(r.data()["automation"]["next_run_at"], DUE, "{r:?}");
    assert_eq!(s.gw.turns("general").await?, [] as [serde_json::Value; 0]);
    Ok(())
}
async fn held_schedule(kind: &str) -> Result<(), HarnessError> {
    let setup = setup("TRANSFER-SCHEDULE")?.clock_after_daily_jobs("2026-10-27T12:00:00.000Z")?;
    schema(&setup.sandbox.data, true)?;
    let mut s = setup.start().await?;
    let (id, bytes, obstacle) = blocked(&mut s).await?;
    // A readable directory still fails a manifest read, and allows the idle watcher to walk it.
    drop(obstacle);
    s.provider()?.set_chat_responder(|_| {
        Some(butler_e2e::e2e::provider::title_response(
            "Complete scheduled report.",
        ))
    });
    let r =
        s.gw.post(
            "/automations",
            json!({
                "id":"held", "title":"Held schedule", "prompt_body":"Prepare a report.",
                "target_session_id":"general", "schedule_type":kind, "interval_seconds":86400,
                "start_at":"2099-01-01T00:00:00.000Z", "run_at":"2099-01-01T00:00:00.000Z"
            }),
        )
        .await?;
    assert_eq!(r.status, 201, "{r:?}");
    s.agent.terminate().await?;
    app(&s)?.execute(
        "UPDATE app_automations SET start_at=?1,run_at=?1,next_run_at=?1 WHERE id='held'",
        [DUE],
    )?;
    s.gw = s.agent.start_again().await?;
    dispatch(&s).await?;
    assert_held(&s).await?;
    // A second restart pins persisted queued-run recovery while the obstacle remains.
    s.agent.terminate().await?;
    s.gw = s.agent.start_again().await?;
    dispatch(&s).await?;
    assert_held(&s).await?;
    let mut watch =
        super::super::idle_resources::writes::Watch::open_after_quiet(&s.sandbox.data).await?;
    let pid = s.agent.pid().unwrap();
    let before = usage::sample(pid)?.unwrap();
    tokio::time::sleep(Duration::from_secs(60)).await;
    let after = usage::sample(pid)?.unwrap();
    let writes = after.write_bytes - before.write_bytes;
    eprintln!(
        "TRANSFER-HOLD kind={kind} idle_seconds=60 disk_write_bytes={writes} buffered_write_bytes={:?}",
        after
            .write_chars
            .zip(before.write_chars)
            .map(|(a, b)| a - b)
    );
    assert!(
        writes <= 1_000_000,
        "idle disk writes exceeded 1 MB: {writes}"
    );
    watch.assert_unchanged();
    drop(watch);
    // Explicit requests write access logs; an unchanged hold must not commit App data.
    let db = app(&s)?;
    let before: u64 = db.query_row("PRAGMA data_version", [], |r| r.get(0))?;
    dispatch(&s).await?;
    dispatch(&s).await?;
    let after: u64 = db.query_row("PRAGMA data_version", [], |r| r.get(0))?;
    eprintln!(
        "TRANSFER-HOLD kind={kind} repeated_check_commits={}",
        after - before
    );
    assert_eq!(after, before, "unchanged hold committed App data");
    drop(db);
    assert_held(&s).await?;
    s.agent.terminate().await?;
    std::fs::remove_dir(manifest(&s.sandbox.data, &id))?;
    std::fs::write(manifest(&s.sandbox.data, &id), bytes)?;
    s.gw = s.agent.start_again().await?;
    assert_finished(&s)?;
    dispatch(&s).await?;
    let records = runs(&s).await?;
    assert_eq!(records.len(), 1, "{records:?}");
    assert_eq!(records[0]["state"], "succeeded", "{records:?}");
    let turn_id = records[0]["turn_id"].as_str().unwrap();
    let turn =
        s.gw.wait_terminal("general", turn_id, Duration::from_secs(90))
            .await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let messages = s.gw.messages("general").await?;
    let replies: Vec<_> = messages
        .iter()
        .filter(|m| m["role"] == "assistant" && m["turn_id"] == turn_id)
        .collect();
    assert_eq!(replies.len(), 1, "{messages:?}");
    assert_eq!(replies[0]["text"], "Complete scheduled report.");
    dispatch(&s).await?;
    assert_eq!(runs(&s).await?.len(), 1);
    assert_eq!(s.gw.turns("general").await?.len(), 1);
    let r = s.gw.get("/automations/held").await?;
    if kind == "once" {
        assert_eq!(r.data()["automation"]["state"], "paused", "{r:?}");
        assert!(r.data()["automation"]["next_run_at"].is_null(), "{r:?}");
    } else {
        assert_eq!(r.data()["automation"]["state"], "enabled", "{r:?}");
        assert_eq!(
            r.data()["automation"]["next_run_at"],
            "2026-10-28T11:00:00.000Z",
            "{r:?}"
        );
    }
    s.finish().await
}
#[tokio::test]
async fn overdue_once_survives_transfer_restart_without_idle_writes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    held_schedule("once").await
}
#[tokio::test]
async fn overdue_recurring_survives_transfer_restart_without_idle_writes()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    held_schedule("interval").await
}
