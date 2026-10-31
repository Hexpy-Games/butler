//! Deleted queued runs must neither wake the scheduler nor strand new work.
use super::*;
use crate::chats_initiated::support::{clock, create, report, runs};
use crate::idle_resources::writes::Watch;
use butler_platform::process_control::usage;

const HELD: &str = "2026-10-27T06:59:59.000Z";
const FREE: &str = "2026-10-27T07:00:00.000Z";
const LIVE: &str = "2026-10-27T07:00:30.000Z";

async fn setup(name: &str, now: &str) -> Result<(Scenario, String), HarnessError> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let address = listener.local_addr()?.to_string();
    drop(listener);
    let mut cassette = butler_e2e::e2e::cassette::Cassette::load("TURN-01")?;
    cassette.exchanges.clear();
    let setup = Setup::new(name)?
        .stub_cassette(cassette)
        .env("TZ", "UTC")
        .env("BUTLER_E2E_APP_NOW", now)
        .env("BUTLER_E2E_APP_CLOCK_ADDRESS", &address);
    crate::memory_fixture::initialize_empty(&setup.sandbox.data)?;
    let s = setup.start().await?;
    s.provider()?.set_chat_responder(|_| {
        Some(butler_e2e::e2e::provider::title_response(
            "Complete scheduled report.",
        ))
    });
    let reply = s.gw.patch("/settings", json!({"timezone":"UTC"})).await?;
    assert_eq!(reply.status, 200, "{reply:?}");
    Ok((s, address))
}

async fn deleted(s: &Scenario) -> Result<(), HarnessError> {
    let reply = s.gw.get("/automations?include_deleted=true").await?;
    assert_eq!(reply.status, 200, "{reply:?}");
    let rows = reply.data()["automations"].as_array().unwrap().clone();
    let row = rows.iter().find(|row| row["id"] == "removed").unwrap();
    assert_eq!(row["state"], "deleted", "{row}");
    assert!(row["next_run_at"].is_null(), "{row}");
    Ok(())
}

async fn observe(s: &Scenario, address: &str) -> Result<(), HarnessError> {
    // Arm the file/commit observer while quiet hours still hold the deleted run.
    // Lifting via the fixture clock changes no files, so the whole minute is idle.
    let mut watch = Watch::open_after_quiet_with_paths(&s.sandbox.data, &[&s.sandbox.logs]).await?;
    let pid = s.agent.pid().unwrap();
    let before = usage::sample(pid)?.unwrap();
    clock(address, FREE).await?;
    tokio::time::sleep(Duration::from_secs(60)).await;
    let after = usage::sample(pid)?.unwrap();
    let cpu = after
        .cpu_time()
        .unwrap()
        .checked_sub(before.cpu_time().unwrap())
        .expect("CPU time must be monotonic");
    let writes = after.write_bytes - before.write_bytes;
    eprintln!(
        "DELETED-SCHEDULE idle_seconds=60 disk_write_bytes={writes} cpu_ms={}",
        cpu.as_millis()
    );
    watch.assert_unchanged();
    assert_eq!(writes, 0, "physical writes during idle");
    drop(watch);
    assert!(
        cpu.as_secs_f64() <= 1.0,
        "scheduler spun after schedule deletion: {cpu:?}"
    );

    deleted(s).await?;
    assert_eq!(runs(s, "live").await?, [] as [Value; 0]);
    // A second observation checks a due schedule inside a real 60-second window.
    // Its expected turn commits are separate from the zero-write idle minute.
    tokio::time::sleep(Duration::from_secs(30)).await;
    clock(address, LIVE).await?;
    let message = report(s, "live").await?;
    assert_eq!(message["text"], "Complete scheduled report.");
    tokio::time::sleep(Duration::from_secs(30)).await;
    deleted(s).await?;
    let live = runs(s, "live").await?;
    assert_eq!(live.len(), 1, "{live:?}");
    assert_eq!(live[0]["state"], "succeeded", "{live:?}");
    assert_eq!(live[0]["scheduled_at"], LIVE, "{live:?}");
    assert_eq!(s.gw.turns("general").await?.len(), 1);
    Ok(())
}

#[tokio::test]
async fn deleted_queued_schedule_idle_cpu_and_writes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, address) = setup("DELETED-SCHEDULE", HELD).await?;
    s.patch_settings(
        json!({"quiet_hours_start":"22:00", "quiet_hours_end":"07:00"}),
        "hold scheduled run",
    )
    .await?;
    create(&s, "removed", "general", HELD).await?;
    let dispatch = s.gw.post("/automations/dispatch-due", json!({})).await?;
    assert_eq!(dispatch.status, 202, "{dispatch:?}");
    let queued = runs(&s, "removed").await?;
    assert_eq!(queued.len(), 1, "{queued:?}");
    assert_eq!(queued[0]["state"], "queued", "{queued:?}");
    assert!(queued[0]["turn_id"].is_null());
    eprintln!(
        "DELETED-SCHEDULE before_delete_run={:?} messages={:?}",
        queued,
        s.gw.messages("general").await?
    );
    let reply = s.gw.delete("/automations/removed").await?;
    assert_eq!(reply.status, 200, "{reply:?}");
    create(&s, "live", "general", LIVE).await?;
    eprintln!(
        "DELETED-SCHEDULE after_delete_run={:?} messages={:?}",
        runs(&s, "removed").await?,
        s.gw.messages("general").await?
    );
    observe(&s, &address).await?;
    let records = runs(&s, "removed").await?;
    assert_eq!(records.len(), 1, "{records:?}");
    assert_eq!(
        records[0]["state"], "skipped_target_unavailable",
        "{records:?}"
    );
    assert!(records[0]["turn_id"].is_null());
    s.finish().await
}

async fn seed_placeholder(s: &mut Scenario) -> Result<(), HarnessError> {
    s.agent.terminate().await?;
    let db = sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    db.execute(
        "INSERT INTO messages(id,chat_id,role,text,status,created_at,updated_at) VALUES('legacy-placeholder','general','automation','Waiting for schedule','pending',?1,?1)",
        [HELD],
    )?;
    db.execute(
        "UPDATE app_automation_runs SET queued_message_id='legacy-placeholder' WHERE automation_id='removed'",
        [],
    )?;
    drop(db);
    s.gw = s.agent.start_again().await?;
    Ok(())
}

#[tokio::test]
async fn deleted_queued_schedule_removes_legacy_placeholder() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, _) = setup("DELETED-SCHEDULE-PLACEHOLDER", HELD).await?;
    s.patch_settings(
        json!({"quiet_hours_start":"22:00", "quiet_hours_end":"07:00"}),
        "hold scheduled run",
    )
    .await?;
    create(&s, "removed", "general", HELD).await?;
    let reply = s.gw.post("/automations/dispatch-due", json!({})).await?;
    assert_eq!(reply.status, 202, "{reply:?}");
    seed_placeholder(&mut s).await?;
    assert!(
        s.gw.messages("general")
            .await?
            .iter()
            .any(|m| m["id"] == "legacy-placeholder")
    );
    let reply = s.gw.delete("/automations/removed").await?;
    assert_eq!(reply.status, 200, "{reply:?}");
    let records = runs(&s, "removed").await?;
    let messages = s.gw.messages("general").await?;
    eprintln!("DELETED-SCHEDULE legacy_after_delete_run={records:?} messages={messages:?}");
    assert_eq!(records.len(), 1);
    assert_eq!(
        records[0]["state"], "skipped_target_unavailable",
        "{records:?}"
    );
    assert!(records[0]["completed_at"].is_string());
    assert!(records[0]["queued_message_id"].is_null());
    assert!(records[0]["turn_id"].is_null());
    assert!(!messages.iter().any(|m| m["id"] == "legacy-placeholder"));
    let events = s.gw.events_since(0).await?;
    assert_eq!(
        events
            .iter()
            .filter(|e| e["type"] == "message.deleted"
                && e["payload"]["message_id"] == "legacy-placeholder")
            .count(),
        1
    );
    // Deleting twice is harmless; the old message removal is published once.
    assert_eq!(s.gw.delete("/automations/removed").await?.status, 200);
    s.restart().await?;
    assert_eq!(runs(&s, "removed").await?, records);
    assert!(
        !s.gw
            .messages("general")
            .await?
            .iter()
            .any(|m| m["id"] == "legacy-placeholder")
    );
    s.finish().await
}

#[tokio::test]
async fn deleted_queued_schedule_existing_rows_idle_cpu_and_writes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, address) = setup("DELETED-SCHEDULE-EXISTING", HELD).await?;
    s.patch_settings(
        json!({"quiet_hours_start":"22:00", "quiet_hours_end":"07:00"}),
        "hold scheduled run",
    )
    .await?;
    create(&s, "removed", "general", HELD).await?;
    let reply = s.gw.post("/automations/dispatch-due", json!({})).await?;
    assert_eq!(reply.status, 202, "{reply:?}");
    assert_eq!(runs(&s, "removed").await?[0]["state"], "queued");
    let reply = s.gw.delete("/automations/removed").await?;
    assert_eq!(reply.status, 200, "{reply:?}");
    // Recreate an older store's stranded queued state after the real deletion.
    // On the baseline this UPDATE leaves the already-queued row unchanged.
    s.agent.terminate().await?;
    let db = sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    db.execute(
        "UPDATE app_automation_runs SET state='queued' WHERE automation_id='removed'",
        [],
    )?;
    drop(db);
    s.gw = s.agent.start_again().await?;
    create(&s, "live", "general", LIVE).await?;
    observe(&s, &address).await?;
    let records = runs(&s, "removed").await?;
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["state"], "queued");
    assert!(records[0]["turn_id"].is_null());
    s.finish().await
}
