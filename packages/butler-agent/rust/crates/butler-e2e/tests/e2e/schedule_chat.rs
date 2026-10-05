//! Ordinary chat discovers schedules and preserves ask-first authority.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use super::schedule_cassette;
#[path = "support/schedule_prompt_budget.rs"]
mod schedule_prompt_budget;

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::gateway::{tool_rows, turn_state};
use butler_e2e::e2e::scenario::{Setup, accepted_turn_id, turn_timeout};
use schedule_cassette::{bridge_result, discovery_cassette};
use serde_json::json;
use std::time::Duration;

const ASK: &str = "매일 아침 7시에 브리핑해줘";
const PROMPT: &str = "오늘의 주요 소식을 브리핑해 주세요.";
const START: &str = "2099-01-01T07:00:00+09:00";

#[tokio::test]
async fn ordinary_chat_creates_schedule_only_after_approval() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut cassette = discovery_cassette(
        ASK,
        "create_automation",
        &json!({
            "id":"morning-briefing", "title":"아침 브리핑", "prompt":PROMPT,
            "schedule_type":"interval", "interval_minutes":1440, "start_at":START
        }),
        1,
    )?;
    for (index, (ask, name, arguments)) in [
        ("예약 작업 목록을 보여 줘", "list_automations", json!({})),
        (
            "아침 브리핑 예약 작업을 일시 중지해 줘",
            "update_automation",
            json!({"id":"morning-briefing", "state":"paused"}),
        ),
        (
            "아침 브리핑 예약 작업을 삭제해 줘",
            "delete_automation",
            json!({"id":"morning-briefing"}),
        ),
    ]
    .into_iter()
    .enumerate()
    {
        cassette
            .exchanges
            .extend(discovery_cassette(ask, name, &arguments, index + 2)?.exchanges);
    }
    let s = Setup::new("SCHED-CHAT")?
        .stub_cassette(cassette)
        .start()
        .await?;
    let controls =
        s.gw.patch(
            "/sessions/general/controls",
            json!({"access_mode":"ask_first"}),
        )
        .await?;
    assert_eq!(controls.status, 200, "{}", controls.text);
    let turn_id = accepted_turn_id(&s.gw.say("general", ASK).await?)?;
    let turn =
        s.gw.wait_turn(
            "general",
            &turn_id,
            &["waiting_for_form", "delivered", "failed"],
            Duration::from_secs(turn_timeout()),
        )
        .await?;
    assert_discovery(&s)?;
    assert_eq!(
        turn_state(&turn),
        "waiting_for_form",
        "{turn}; misses: {:?}",
        s.provider()?.misses()
    );
    let requests =
        s.gw.get("/authority-requests?session_id=general")
            .await?
            .data()
            .clone();
    let request = requests["requests"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["source_turn_id"] == turn_id)
        .unwrap();
    let reference = request["request_ref"]
        .as_str()
        .or_else(|| request["ref"].as_str())
        .unwrap();
    assert_eq!(s.gw.get("/automations/morning-briefing").await?.status, 404);
    let allowed =
        s.gw.post(
            &format!("/authority-requests/{reference}/allow?session_id=general"),
            json!({"scope":"conversation"}),
        )
        .await?;
    assert_eq!(allowed.status, 202, "{}", allowed.text);
    let turn =
        s.gw.wait_terminal("general", &turn_id, Duration::from_secs(turn_timeout()))
            .await?;
    assert_eq!(
        turn_state(&turn),
        "delivered",
        "{turn}; misses: {:?}",
        s.provider()?.misses()
    );
    let rows = tool_rows(&s.gw.messages("general").await?, &turn_id);
    assert!(
        rows.iter().any(|r| r["safe_tool_name"] == "tool_search"),
        "{rows:?}"
    );
    assert!(
        rows.iter().any(|r| r["safe_tool_name"] == "tool_describe"),
        "{rows:?}"
    );
    let schedule = s.gw.get("/automations/morning-briefing").await?.data()["automation"].clone();
    assert_eq!(schedule["prompt_body"], PROMPT);
    assert_eq!(schedule["interval_seconds"], 86400);
    assert_eq!(schedule["next_run_at"], "2098-12-31T22:00:00.000Z");
    assert_eq!(schedule["access_mode"], "ask_first");
    assert!(s.provider()?.misses().is_empty());
    assert_authority(&s, &turn_id, "create_automation")?;
    let requests = s.provider()?.requests();
    let tools = requests[0]["tools"].to_string();
    for name in [
        "create_automation",
        "list_automations",
        "update_automation",
        "delete_automation",
    ] {
        assert!(
            !tools.contains(name),
            "schedule schema was made always visible: {tools}"
        );
    }
    assert!(
        rows.iter()
            .all(|r| r["safe_tool_name"] != "delegate_to_steward")
    );
    assert!(
        s.gw.get("/session-view?session_id=general").await?.data()["steward_children"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    schedule_prompt_budget::assert_budget();
    manage_schedule(&s).await?;
    s.finish().await
}

async fn manage_schedule(s: &butler_e2e::e2e::scenario::Scenario) -> Result<(), HarnessError> {
    let (id, turn) = s.turn("general", "예약 작업 목록을 보여 줘").await?;
    assert_eq!(
        turn_state(&turn),
        "delivered",
        "{turn}; {:?}",
        s.provider()?.misses()
    );
    let listed = bridge_result(s, &id, "list_automations").await?;
    assert_eq!(listed["automations"].as_array().unwrap().len(), 1);
    assert_eq!(listed["automations"][0]["id"], "morning-briefing");
    for (ask, expected) in [
        ("아침 브리핑 예약 작업을 일시 중지해 줘", "paused"),
        ("아침 브리핑 예약 작업을 삭제해 줘", "deleted"),
    ] {
        let id = accepted_turn_id(&s.gw.say("general", ask).await?)?;
        let turn =
            s.gw.wait_turn(
                "general",
                &id,
                &["waiting_for_form", "delivered", "failed"],
                Duration::from_secs(turn_timeout()),
            )
            .await?;
        assert_eq!(
            turn_state(&turn),
            "waiting_for_form",
            "{turn}; {:?}",
            s.provider()?.misses()
        );
        let before = s.gw.get("/automations/morning-briefing").await?.data()["automation"].clone();
        assert_eq!(
            before["state"],
            if expected == "paused" {
                "enabled"
            } else {
                "paused"
            },
            "schedule changed before approval: {before}"
        );
        allow(s, &id).await?;
        let turn =
            s.gw.wait_terminal("general", &id, Duration::from_secs(turn_timeout()))
                .await?;
        assert_eq!(
            turn_state(&turn),
            "delivered",
            "{turn}; {:?}",
            s.provider()?.misses()
        );
        let schedules =
            s.gw.get("/automations?include_deleted=true")
                .await?
                .data()
                .clone();
        let schedule = schedules["automations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == "morning-briefing")
            .unwrap();
        assert_eq!(schedule["state"], expected, "{schedule}");
        assert_authority(
            s,
            &id,
            if expected == "paused" {
                "update_automation"
            } else {
                "delete_automation"
            },
        )?;
    }
    assert!(s.provider()?.misses().is_empty());
    Ok(())
}

async fn allow(s: &butler_e2e::e2e::scenario::Scenario, turn_id: &str) -> Result<(), HarnessError> {
    let requests =
        s.gw.get("/authority-requests?session_id=general")
            .await?
            .data()
            .clone();
    let request = requests["requests"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["source_turn_id"] == turn_id)
        .unwrap();
    let reference = request["request_ref"]
        .as_str()
        .or_else(|| request["ref"].as_str())
        .unwrap();
    let allowed =
        s.gw.post(
            &format!("/authority-requests/{reference}/allow?session_id=general"),
            json!({"scope":"once"}),
        )
        .await?;
    assert_eq!(allowed.status, 202, "{}", allowed.text);
    Ok(())
}

fn assert_authority(
    s: &butler_e2e::e2e::scenario::Scenario,
    turn: &str,
    capability: &str,
) -> Result<(), HarnessError> {
    let db = butler_platform::sqlite::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))
        .map_err(|e| HarnessError(e.to_string()))?;
    let record: (String, String, String) = db.query_row(
        "SELECT capability, decision, outcome FROM btcc_authority_requests WHERE source_turn_id=?1",
        [turn], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    ).map_err(|e| HarnessError(e.to_string()))?;
    assert_eq!(
        record,
        (capability.into(), "allowed".into(), "applied".into())
    );
    Ok(())
}

fn assert_discovery(s: &butler_e2e::e2e::scenario::Scenario) -> Result<(), HarnessError> {
    let db = butler_platform::sqlite::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))
        .map_err(|e| HarnessError(e.to_string()))?;
    let result: String = db.query_row(
        "SELECT result_json FROM btcc_guided_tool_calls WHERE tool_name='tool_describe' ORDER BY turn_sequence LIMIT 1",
        [], |r| r.get(0),
    ).map_err(|e| HarnessError(e.to_string()))?;
    let descriptions: serde_json::Value = serde_json::from_str(&result)?;
    let entries = descriptions["descriptions"].as_array().unwrap();
    assert_eq!(entries.len(), 4, "{descriptions}");
    for entry in entries {
        assert_eq!(
            entry["enabled"], true,
            "{}: {}",
            entry["id"], entry["disabled_reason"]
        );
    }
    Ok(())
}
