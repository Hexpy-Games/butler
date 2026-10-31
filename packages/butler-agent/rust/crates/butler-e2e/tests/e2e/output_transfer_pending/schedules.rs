use super::*;
use butler_platform::process_control::usage;
use std::time::Duration;

const DUE: &str = "2026-10-27T11:00:00.000Z";
const FUTURE: &str = "2099-01-01T00:00:00.000Z";

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
async fn create(s: &Scenario, kind: &str) -> Result<(), HarnessError> {
    let r =
        s.gw.post(
            "/automations",
            json!({
                "id":"held", "title":"Held schedule", "prompt_body":"Prepare a report.",
                "target_session_id":"general", "schedule_type":kind, "interval_seconds":86400,
                "start_at":FUTURE, "run_at":FUTURE
            }),
        )
        .await?;
    assert_eq!(r.status, 201, "{r:?}");
    Ok(())
}
async fn start() -> Result<Scenario, HarnessError> {
    let setup = setup("TRANSFER-SCHEDULE")?.clock_after_daily_jobs("2026-10-27T12:00:00.000Z")?;
    schema(&setup.sandbox.data, true)?;
    let s = setup.start().await?;
    s.provider()?.set_chat_responder(|_| {
        Some(butler_e2e::e2e::provider::title_response(
            "Complete scheduled report.",
        ))
    });
    Ok(s)
}
async fn overdue(s: &mut Scenario) -> Result<(), HarnessError> {
    s.agent.terminate().await?;
    app(s)?.execute(
        "UPDATE app_automations SET start_at=?1,run_at=?1,next_run_at=?1 WHERE id='held'",
        [DUE],
    )?;
    s.gw = s.agent.start_again().await?;
    Ok(())
}
async fn assert_not_due(s: &Scenario) -> Result<(), HarnessError> {
    let records = runs(s).await?;
    assert!(
        records.is_empty(),
        "relocate gate created a run: {records:?}"
    );
    let r = s.gw.get("/automations/held").await?;
    assert_eq!(r.data()["automation"]["state"], "enabled", "{r:?}");
    assert_eq!(r.data()["automation"]["next_run_at"], DUE, "{r:?}");
    assert_eq!(s.gw.turns("general").await?, [] as [serde_json::Value; 0]);
    Ok(())
}
async fn assert_queued(s: &Scenario) -> Result<String, HarnessError> {
    let records = runs(s).await?;
    assert_eq!(records.len(), 1, "{records:?}");
    assert_eq!(records[0]["state"], "queued", "{records:?}");
    assert!(records[0]["turn_id"].is_null(), "{records:?}");
    assert!(records[0]["safe_error_code"].is_null(), "{records:?}");
    Ok(records[0]["id"].as_str().unwrap().to_owned())
}
async fn assert_once(s: &Scenario) -> Result<serde_json::Value, HarnessError> {
    // Observe only: a missing gate-lift wake must not be rescued by dispatch-due.
    let record = tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            let records = runs(s).await?;
            assert!(records.len() <= 1, "duplicate runs: {records:?}");
            if let Some(record) = records.first() {
                assert_ne!(record["state"], "failed", "{record}");
                if record["state"] == "succeeded" {
                    return Ok::<_, HarnessError>(record.clone());
                }
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .map_err(|_| HarnessError("gate lift did not wake the schedule".into()))??;
    let turn_id = record["turn_id"].as_str().unwrap();
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
    dispatch(s).await?;
    assert_eq!(runs(s).await?.len(), 1);
    assert_eq!(s.gw.turns("general").await?.len(), 1);
    Ok(record)
}
async fn idle(s: &Scenario, kind: &str) -> Result<(), HarnessError> {
    let mut watch =
        super::super::idle_resources::writes::Watch::open_after_quiet(&s.sandbox.data).await?;
    let pid = s.agent.pid().unwrap();
    let before = usage::sample(pid)?.unwrap();
    tokio::time::sleep(Duration::from_secs(60)).await;
    let after = usage::sample(pid)?.unwrap();
    let writes = after.write_bytes - before.write_bytes;
    let cpu = after.cpu_time().zip(before.cpu_time()).map(|(a, b)| a - b);
    eprintln!(
        "TRANSFER-HOLD kind={kind} idle_seconds=60 disk_write_bytes={writes} buffered_write_bytes={:?} cpu_ms={:?}",
        after
            .write_chars
            .zip(before.write_chars)
            .map(|(a, b)| a - b),
        cpu.map(|time| time.as_millis())
    );
    assert_eq!(writes, 0, "physical writes while gated");
    assert!(
        after
            .write_chars
            .zip(before.write_chars)
            .is_none_or(|(a, b)| a == b),
        "buffered writes while gated: before={:?} after={:?}",
        before.write_chars,
        after.write_chars
    );
    // More than one CPU second in a minute is sustained work for an idle agent.
    if let Some(cpu) = cpu {
        assert!(
            cpu <= Duration::from_secs(1),
            "scheduler spun while gated: {cpu:?}"
        );
    }
    watch.assert_unchanged();
    drop(watch);
    assert_not_due(s).await?;
    let db = app(s)?;
    let before: u64 = db.query_row("PRAGMA data_version", [], |r| r.get(0))?;
    dispatch(s).await?;
    dispatch(s).await?;
    let after: u64 = db.query_row("PRAGMA data_version", [], |r| r.get(0))?;
    assert_eq!(after, before, "unchanged gate committed App data");
    Ok(())
}
async fn held_schedule(kind: &str, runtime: bool) -> Result<(), HarnessError> {
    let mut s = start().await?;
    let (id, bytes, obstacle) = blocked(&mut s).await?;
    // A readable directory fails manifest reads and lets the idle watcher walk it.
    drop(obstacle);
    let archive = pending(&s)?;
    create(&s, kind).await?;
    overdue(&mut s).await?;
    dispatch(&s).await?;
    assert_not_due(&s).await?;
    s.agent.terminate().await?;
    s.gw = s.agent.start_again().await?;
    dispatch(&s).await?;
    assert_not_due(&s).await?;
    if runtime {
        let r =
            s.gw.delete(&format!("/sessions/{archive}?permanent=true"))
                .await?;
        assert_eq!(r.status, 409, "{r:?}");
        assert_pending(&s, &archive)?;
        // Let all prior signals settle before lifting through the delete retry.
        let watch =
            super::super::idle_resources::writes::Watch::open_after_quiet(&s.sandbox.data).await?;
        drop(watch);
    } else {
        idle(&s, kind).await?;
        s.agent.terminate().await?;
    }
    std::fs::remove_dir(manifest(&s.sandbox.data, &id))?;
    std::fs::write(manifest(&s.sandbox.data, &id), bytes)?;
    if runtime {
        let r =
            s.gw.delete(&format!("/sessions/{archive}?permanent=true"))
                .await?;
        assert_eq!(r.status, 200, "{r:?}");
    } else {
        s.gw = s.agent.start_again().await?;
    }
    assert_finished(&s)?;
    assert_once(&s).await?;
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
    held_schedule("once", false).await
}
#[tokio::test]
async fn overdue_recurring_survives_transfer_restart_without_idle_writes()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    held_schedule("interval", false).await
}
#[tokio::test]
async fn runtime_transfer_lift_wakes_once_without_dispatch_request() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    held_schedule("once", true).await
}
#[tokio::test]
async fn runtime_transfer_lift_wakes_recurring_without_dispatch_request() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    held_schedule("interval", true).await
}
#[tokio::test]
async fn queued_run_waits_when_transfer_gate_appears() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = start().await?;
    s.patch_settings(
        json!({"quiet_hours_start":"00:00", "quiet_hours_end":"23:00"}),
        "quiet hours",
    )
    .await?;
    create(&s, "once").await?;
    overdue(&mut s).await?;
    dispatch(&s).await?;
    let run = assert_queued(&s).await?;
    let (id, bytes, obstacle) = blocked(&mut s).await?;
    s.patch_settings(
        json!({"quiet_hours_start":"22:00", "quiet_hours_end":"07:00"}),
        "quiet hours",
    )
    .await?;
    dispatch(&s).await?;
    assert_eq!(assert_queued(&s).await?, run);
    s.agent.terminate().await?;
    s.gw = s.agent.start_again().await?;
    dispatch(&s).await?;
    assert_eq!(assert_queued(&s).await?, run);
    let archive = pending(&s)?;
    restore(&s, &id, bytes, obstacle)?;
    let r =
        s.gw.delete(&format!("/sessions/{archive}?permanent=true"))
            .await?;
    assert_eq!(r.status, 200, "{r:?}");
    assert_eq!(assert_once(&s).await?["id"], run);
    s.finish().await
}
#[tokio::test]
async fn manual_run_waits_behind_transfer_gate() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = start().await?;
    let (id, bytes, obstacle) = blocked(&mut s).await?;
    create(&s, "once").await?;
    let r = s.gw.post("/automations/held/run", json!({})).await?;
    assert_eq!(r.status, 202, "{r:?}");
    let run = assert_queued(&s).await?;
    let archive = pending(&s)?;
    restore(&s, &id, bytes, obstacle)?;
    let r =
        s.gw.delete(&format!("/sessions/{archive}?permanent=true"))
            .await?;
    assert_eq!(r.status, 200, "{r:?}");
    assert_eq!(assert_once(&s).await?["id"], run);
    let r = s.gw.get("/automations/held").await?;
    assert_eq!(r.data()["automation"]["state"], "paused", "{r:?}");
    assert!(r.data()["automation"]["next_run_at"].is_null(), "{r:?}");
    s.finish().await
}
