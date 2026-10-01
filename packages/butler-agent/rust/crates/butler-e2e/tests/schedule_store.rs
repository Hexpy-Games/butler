//! E2E coverage for the canonical schedule store and idle scheduler.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::time::{Duration, Instant};

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::cassette::{Cassette, ResponseRecord};
use butler_e2e::e2e::gateway::{tool_rows, turn_state};
use butler_e2e::e2e::scenario::{Scenario, Setup};
use serde_json::{Value, json};

const CHAT_REQUEST: &str =
    "Create a 60-minute schedule titled Chat schedule to summarize today's changes.";
const SCHEDULER_READ_COUNT_PATH: &str = "/automations/_test/scheduler-next-due-reads";

fn stub_schedule_cassette() -> Result<Cassette, HarnessError> {
    let mut cassette = Cassette::load("TOOL-02")?;
    cassette.scenario = "SCHED-05".into();
    cassette.meta.scenario = cassette.scenario.clone();
    let final_response = cassette.exchanges[6].response.clone();
    for exchange in &mut cassette.exchanges {
        exchange.request.key.user_request = CHAT_REQUEST.into();
    }
    let objective = "Create the requested chat schedule.";
    let action = "Create the chat schedule";
    rewrite_tool_call(
        &mut cassette.exchanges[0].response,
        "start_work",
        &json!({"objective": objective}),
    )?;
    rewrite_tool_call(
        &mut cassette.exchanges[1].response,
        "replace_work_plan",
        &json!({
            "objective": objective,
            "execution_mode": "direct",
            "actions": [{
                "action_key": action,
                "effect": {"capability": "Create a recurring schedule", "target": "Chat schedule in general"}
            }],
            "checks": ["The schedule appears in the API and CLI."]
        }),
    )?;
    rewrite_tool_call(
        &mut cassette.exchanges[2].response,
        "record_work_review",
        &json!({
            "subject": "plan",
            "verdict": "accept",
            "summary": "The plan covers creating the requested schedule.",
            "action_updates": [{"action_key": action, "status": "active"}]
        }),
    )?;
    rewrite_tool_call(
        &mut cassette.exchanges[3].response,
        "create_automation",
        &json!({
            "title":"Chat schedule",
            "prompt":"Summarize today's changes.",
            "session_id":"general",
            "schedule_type":"interval",
            "interval_minutes":60
        }),
    )?;
    let mut disposition = tool_arguments(&cassette.exchanges[5].response)?;
    disposition["summary"] = "Created the requested chat schedule.".into();
    disposition["action_updates"] = json!([{"action_key": action, "status": "done"}]);
    rewrite_tool_call(
        &mut cassette.exchanges[4].response,
        "record_work_disposition",
        &disposition,
    )?;
    cassette.exchanges[5].request.key.round = [
        "function_call",
        "function_call_output",
        "user",
        "function_call",
        "function_call_output",
        "user",
        "function_call",
        "function_call_output",
        "user",
        "function_call",
        "function_call_output",
        "function_call",
        "function_call_output",
        "user",
        "user",
    ]
    .map(str::to_owned)
    .to_vec();
    cassette.exchanges[5].response = final_response;
    cassette.exchanges.truncate(6);
    rewrite_final_text(&mut cassette.exchanges[5].response)?;
    Ok(cassette)
}

fn tool_arguments(response: &ResponseRecord) -> Result<Value, HarnessError> {
    for chunk in &response.chunks {
        for line in chunk.text.lines() {
            let Some(data) = line.strip_prefix("data: ") else {
                continue;
            };
            let Ok(event) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            if event["type"] == "response.output_item.done"
                && event["item"]["type"] == "function_call"
            {
                return serde_json::from_str(
                    event["item"]["arguments"].as_str().unwrap_or_default(),
                )
                .map_err(|error| HarnessError(error.to_string()));
            }
        }
    }
    Err(HarnessError(
        "stub cassette has no function arguments".into(),
    ))
}

fn rewrite_tool_call(
    response: &mut ResponseRecord,
    name: &str,
    arguments: &Value,
) -> Result<(), HarnessError> {
    let arguments = arguments.to_string();
    let mut found = false;
    let mut sent_delta = false;
    rewrite_events(response, |event| {
        match event["type"].as_str() {
            Some("response.function_call_arguments.delta") => {
                event["delta"] = if sent_delta {
                    String::new().into()
                } else {
                    sent_delta = true;
                    arguments.as_str().into()
                };
            }
            Some("response.function_call_arguments.done") => {
                event["arguments"] = arguments.as_str().into();
            }
            _ => {}
        }
        rewrite_tool_items(event, name, &arguments, &mut found);
    })?;
    if found {
        Ok(())
    } else {
        Err(HarnessError("stub cassette has no function call".into()))
    }
}

fn rewrite_tool_items(value: &mut Value, name: &str, arguments: &str, found: &mut bool) {
    match value {
        Value::Object(object) => {
            if object.get("type").and_then(Value::as_str) == Some("function_call") {
                object.insert("name".into(), name.into());
                object.insert("arguments".into(), arguments.into());
                *found = true;
            }
            for nested in object.values_mut() {
                rewrite_tool_items(nested, name, arguments, found);
            }
        }
        Value::Array(items) => {
            for nested in items {
                rewrite_tool_items(nested, name, arguments, found);
            }
        }
        _ => {}
    }
}

fn rewrite_final_text(response: &mut ResponseRecord) -> Result<(), HarnessError> {
    let mut sent_delta = false;
    rewrite_events(response, |event| {
        if event["type"] == "response.output_text.delta" {
            event["delta"] = if sent_delta {
                String::new().into()
            } else {
                sent_delta = true;
                "Created the schedule.".into()
            };
        }
        if event["type"] == "response.output_text.done" {
            event["text"] = "Created the schedule.".into();
        }
        rewrite_message_text(event);
    })?;
    if sent_delta {
        Ok(())
    } else {
        Err(HarnessError("stub cassette has no final text".into()))
    }
}

fn rewrite_message_text(value: &mut Value) {
    match value {
        Value::Object(object) => {
            if object.get("type").and_then(Value::as_str) == Some("output_text")
                && object.contains_key("text")
            {
                object.insert("text".into(), "Created the schedule.".into());
            }
            for nested in object.values_mut() {
                rewrite_message_text(nested);
            }
        }
        Value::Array(items) => {
            for nested in items {
                rewrite_message_text(nested);
            }
        }
        _ => {}
    }
}

fn rewrite_events(
    response: &mut ResponseRecord,
    mut rewrite: impl FnMut(&mut Value),
) -> Result<(), HarnessError> {
    for chunk in &mut response.chunks {
        let mut text = String::with_capacity(chunk.text.len());
        for line in chunk.text.split_inclusive('\n') {
            let Some(data) = line.strip_prefix("data: ") else {
                text.push_str(line);
                continue;
            };
            let payload = data.strip_suffix('\n').unwrap_or(data);
            let Ok(mut event) = serde_json::from_str::<Value>(payload) else {
                text.push_str(line);
                continue;
            };
            rewrite(&mut event);
            text.push_str("data: ");
            text.push_str(
                &serde_json::to_string(&event).map_err(|error| HarnessError(error.to_string()))?,
            );
            if line.ends_with('\n') {
                text.push('\n');
            }
        }
        chunk.text = text;
    }
    Ok(())
}

#[tokio::test]
async fn sched_05_chat_tool_schedule_is_shared_and_editable() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("SCHED-05")?
        .env("BUTLER_E2E_ENABLE_SCHEDULE_CREATE_TOOL", "1")
        .stub_cassette(stub_schedule_cassette()?)
        .start()
        .await?;
    let (turn_id, turn) = s.turn("general", CHAT_REQUEST).await?;
    let rows = tool_rows(&s.gw.messages("general").await?, &turn_id);
    let create = rows
        .iter()
        .find(|row| row["safe_tool_name"] == "create_automation")
        .unwrap_or_else(|| panic!("create_automation was not called: {rows:?}"));
    assert!(
        create["state"] == "delivered",
        "schedule tool call failed: {create:?}"
    );

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
