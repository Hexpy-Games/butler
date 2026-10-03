//! E2E coverage for the canonical schedule store and idle scheduler.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::time::{Duration, Instant};

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::gateway::turn_state;
use butler_e2e::e2e::scenario::{Scenario, Setup};
use serde_json::json;

#[path = "support/schedule_cassette.rs"]
mod schedule_cassette;
use schedule_cassette::{CHAT_REQUEST, bridge_result, discovery_cassette};
const SCHEDULER_READ_COUNT_PATH: &str = "/automations/_test/scheduler-next-due-reads";

#[tokio::test]
async fn sched_05_chat_tool_schedule_is_shared_and_editable() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("SCHED-05")?
        .stub_cassette(discovery_cassette(
            CHAT_REQUEST,
            "create_automation",
            &json!({
                "title":"Chat schedule", "prompt":"Summarize today's changes.",
                "session_id":"general", "schedule_type":"interval", "interval_minutes":60
            }),
            1,
        )?)
        .start()
        .await?;
    let (turn_id, turn) = s.turn("general", CHAT_REQUEST).await?;
    bridge_result(&s, &turn_id, "create_automation").await?;

    let api = s.gw.get("/automations").await?;
    assert_eq!(api.status, 200, "{}", api.text);
    let id = api.data()["automations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|schedule| schedule["title"] == "Chat schedule")
        .unwrap_or_else(|| panic!("chat schedule is missing: {}", api.text))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let cli_list = s.agent.cli_async(&["schedule", "list", "--json"]).await?;
    assert_eq!(cli_list.code, Some(0), "{}", cli_list.stderr);
    assert!(
        cli_list.json()?["data"]["automations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|schedule| schedule["id"] == id),
        "CLI omitted chat-created schedule: {}",
        cli_list.stdout
    );

    let cli_edit = s
        .agent
        .cli_async(&["schedule", "update", &id, "--title", "CLI edited", "--json"])
        .await?;
    assert_eq!(cli_edit.code, Some(0), "{}", cli_edit.stderr);
    assert_eq!(
        s.gw.get(&format!("/automations/{id}")).await?.data()["automation"]["title"],
        "CLI edited"
    );
    let api_edit =
        s.gw.patch(&format!("/automations/{id}"), json!({"title":"API edited"}))
            .await?;
    assert_eq!(api_edit.status, 200, "{}", api_edit.text);
    let cli_show = s
        .agent
        .cli_async(&["schedule", "show", &id, "--json"])
        .await?;
    assert_eq!(cli_show.code, Some(0), "{}", cli_show.stderr);
    assert_eq!(
        cli_show.json()?["data"]["automation"]["title"],
        "API edited"
    );
    let misses = s.provider()?.misses();
    assert!(misses.is_empty(), "stub replay misses: {misses:?}");
    assert_eq!(
        turn_state(&turn),
        "delivered",
        "{turn}; replay misses: {misses:?}"
    );
    s.finish().await
}

async fn scheduler_next_due_reads(s: &Scenario) -> Result<usize, HarnessError> {
    let reply = s.gw.get(SCHEDULER_READ_COUNT_PATH).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    usize::try_from(reply.data().as_u64().unwrap_or_default())
        .map_err(|error| HarnessError(error.to_string()))
}

#[tokio::test]
async fn sched_06_idle_calendar_scheduler_reads_only_on_change_in_60_seconds()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("SCHED-06")?
        .env("BUTLER_E2E_SCHEDULER_INSTRUMENTATION", "1")
        .env("BUTLER_E2E_APP_NOW", "2026-03-07T00:00:00.000Z")
        .env("BUTLER_E2E_TIER", "stub")
        .start()
        .await?;
    let schedules = s.gw.get("/automations").await?;
    assert!(
        schedules.data()["automations"]
            .as_array()
            .unwrap()
            .is_empty(),
        "idle fixture contains a schedule: {}",
        schedules.text
    );

    let deadline = Instant::now() + Duration::from_secs(10);
    let mut reads = 0;
    while reads == 0 && Instant::now() < deadline {
        reads = scheduler_next_due_reads(&s).await?;
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(
        reads, 1,
        "scheduler did not make exactly one initial due lookup"
    );
    let created =
        s.gw.post(
            "/automations",
            json!({"id":"idle-calendar","title":"Morning",
        "target_session_id":"general","prompt_body":"Brief me",
        "schedule":{"kind":"daily","time":"08:00","tz":"UTC"}}),
        )
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let before = s.gw.get("/automations").await?.data()["automations"].clone();
    assert_eq!(before.as_array().unwrap().len(), 1);
    assert_eq!(before[0]["id"], "idle-calendar");
    assert_eq!(before[0]["next_run_at"], "2026-03-07T08:00:00.000Z");
    let deadline = Instant::now() + Duration::from_secs(10);
    while scheduler_next_due_reads(&s).await? < 2 && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(scheduler_next_due_reads(&s).await?, 2);
    tokio::time::sleep(Duration::from_secs(60)).await;
    assert_eq!(
        scheduler_next_due_reads(&s).await?,
        2,
        "scheduler repeated the due lookup during the idle window"
    );
    let after = s.gw.get("/automations").await?.data()["automations"].clone();
    assert_eq!(
        after, before,
        "idle calendar row changed without a mutation"
    );
    s.finish().await
}
