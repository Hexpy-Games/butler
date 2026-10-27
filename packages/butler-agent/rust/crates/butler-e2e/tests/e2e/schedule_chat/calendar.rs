//! Calendar tool calls use request structure only, through discovery and approval.
use butler_e2e::e2e::{
    HarnessError,
    cassette::{Cassette, Chunk, ResponseRecord},
    fixtures,
    gateway::turn_state,
    provider::title_response,
    scenario::{Fixture, Scenario, Setup, accepted_turn_id, turn_timeout},
};
use serde_json::{Value, json};
use std::time::Duration;

async fn start(
    now: &str,
    responder: fn(&Value) -> Option<ResponseRecord>,
) -> Result<Scenario, HarnessError> {
    let mut cassette = Cassette::load("TOOL-01")?;
    cassette.exchanges.clear();
    let setup = Setup::new("SCHED-CHAT-CALENDAR")?
        .fixture(Fixture::Empty)
        .stub_cassette(cassette)
        .env("BUTLER_E2E_APP_NOW", now);
    fixtures::onboarding_complete(&setup.sandbox.data)?;
    fixtures::scheduler_ran_today(&setup.sandbox.data, now)?;
    let s = setup.start().await?;
    s.patch_settings(json!({"timezone":"America/New_York"}), "user timezone")
        .await?;
    s.provider()?.set_chat_responder(responder);
    let controls =
        s.gw.patch(
            "/sessions/general/controls",
            json!({"access_mode":"ask_first"}),
        )
        .await?;
    assert_eq!(controls.status, 200, "{}", controls.text);
    Ok(s)
}

#[tokio::test]
async fn daily_and_weekdays_tool_approval_uses_user_timezone_across_dst() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    for (kind, now, expected) in [
        (
            "daily",
            "2026-10-30T13:00:00.000Z",
            "2026-10-31T11:50:00.000Z",
        ),
        (
            "daily",
            "2026-10-31T13:00:00.000Z",
            "2026-11-01T12:50:00.000Z",
        ),
        (
            "weekdays",
            "2026-10-30T13:00:00.000Z",
            "2026-11-02T12:50:00.000Z",
        ),
    ] {
        let s = start(now, if kind == "daily" { daily } else { weekdays }).await?;
        let (_, turn) = request_and_approve(&s, kind, Some("07:50")).await?;
        assert_eq!(turn_state(&turn), "delivered", "{turn}");
        let reply = s.gw.get("/automations/briefing").await?;
        assert_eq!(reply.status, 200, "{}", reply.text);
        let automation = &reply.data()["automation"];
        let (stored_kind, weekdays) = if kind == "daily" {
            ("daily", json!([]))
        } else {
            ("weekly", json!([1, 2, 3, 4, 5]))
        };
        assert_eq!(
            automation["schedule"],
            json!({"kind":stored_kind, "time":"07:50",
            "weekdays":weekdays, "tz":"America/New_York"})
        );
        assert_eq!(automation["next_run_at"], expected);
        assert_eq!(automation["prompt_body"], "Brief me.");
        assert_eq!(automation["target_session_id"], "general");
        assert_eq!(
            s.gw.get("/automations").await?.data()["automations"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(s.provider()?.misses(), [] as [String; 0]);
        s.finish().await?;
    }
    Ok(())
}

#[tokio::test]
async fn calendar_tool_missing_and_invalid_time_create_nothing() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for (kind, time) in [("daily", None), ("weekdays", Some("25:70"))] {
        let s = start(
            "2026-10-31T13:00:00.000Z",
            if time.is_none() {
                missing_time
            } else {
                invalid_time
            },
        )
        .await?;
        let (_, turn) = request_and_approve(&s, kind, time).await?;
        assert_eq!(turn_state(&turn), "delivered", "{turn}");
        let requests = s.provider()?.requests();
        let output: Value = requests
            .iter()
            .flat_map(|request| request["input"].as_array().into_iter().flatten())
            .filter(|item| {
                item["type"] == "function_call_output" && item["call_id"] == "calendar_tool_call"
            })
            .find_map(|item| serde_json::from_str(item["output"].as_str()?).ok())
            .expect("the model received the schedule tool result");
        assert_eq!(output["ok"], false, "{output}");
        assert_eq!(
            output["error"]["code"], "effect_dispatch_failed",
            "{output}"
        );
        assert_eq!(
            output["error"]["message"],
            "automation_interval_invalid: Schedule timing is invalid."
        );
        let mut rule = if kind == "daily" {
            json!({"kind":"daily"})
        } else {
            json!({"kind":"weekly", "weekdays":[1,2,3,4,5]})
        };
        if let Some(time) = time {
            rule["time"] = time.into();
        }
        let rejected =
            s.gw.post(
                "/automations",
                json!({"id":"briefing", "title":"Briefing",
            "prompt_body":"Brief me.", "target_session_id":"general", "schedule":rule}),
            )
            .await?;
        assert_eq!(rejected.status, 400, "{}", rejected.text);
        assert_eq!(
            rejected.body["error"]["code"],
            "automation_interval_invalid"
        );
        assert_eq!(s.gw.get("/automations/briefing").await?.status, 404);
        assert_eq!(
            s.gw.get("/automations").await?.data()["automations"],
            json!([])
        );
        assert_eq!(s.provider()?.misses(), [] as [String; 0]);
        s.finish().await?;
    }
    Ok(())
}

async fn request_and_approve(
    s: &Scenario,
    kind: &str,
    time: Option<&str>,
) -> Result<(String, Value), HarnessError> {
    let id = accepted_turn_id(&s.gw.say("general", "Set up my briefing schedule.").await?)?;
    let turn =
        s.gw.wait_turn(
            "general",
            &id,
            &["waiting_for_form", "delivered", "failed"],
            Duration::from_secs(turn_timeout()),
        )
        .await?;
    assert_eq!(turn_state(&turn), "waiting_for_form", "{turn}");
    let requests = s.gw.approval_requests("general").await?;
    let request = requests.iter().find(|r| r["source_turn_id"] == id).unwrap();
    assert_eq!(request["approval"]["schedule"]["schedule_type"], kind);
    assert_eq!(request["approval"]["schedule"]["time"], json!(time));
    assert_eq!(s.gw.get("/automations/briefing").await?.status, 404);
    super::allow(s, &id).await?;
    let turn =
        s.gw.wait_terminal("general", &id, Duration::from_secs(turn_timeout()))
            .await?;
    Ok((id, turn))
}

fn daily(body: &Value) -> Option<ResponseRecord> {
    calendar(body, "daily", Some("07:50"))
}
fn weekdays(body: &Value) -> Option<ResponseRecord> {
    calendar(body, "weekdays", Some("07:50"))
}
fn missing_time(body: &Value) -> Option<ResponseRecord> {
    calendar(body, "daily", None)
}
fn invalid_time(body: &Value) -> Option<ResponseRecord> {
    calendar(body, "weekdays", Some("25:70"))
}
fn calendar(body: &Value, kind: &str, time: Option<&str>) -> Option<ResponseRecord> {
    let mut args =
        json!({"id":"briefing", "title":"Briefing", "prompt":"Brief me.", "schedule_type":kind});
    if let Some(time) = time {
        args["time"] = time.into();
    }
    respond(body, &args)
}

fn respond(body: &Value, args: &Value) -> Option<ResponseRecord> {
    if body["tools"].as_array().is_none_or(Vec::is_empty) {
        return Some(title_response("Briefing schedule"));
    }
    let inputs = body["input"].as_array()?;
    let done = |id: &str| {
        inputs
            .iter()
            .any(|i| i["type"] == "function_call_output" && i["call_id"] == id)
    };
    let work = inputs
        .iter()
        .filter_map(|i| i["output"].as_str())
        .filter_map(|text| serde_json::from_str::<Value>(text).ok())
        .find_map(|v| work_id(&v));
    let (id, name, arguments) = if !done("calendar_describe") {
        (
            "calendar_describe",
            "tool_describe",
            json!({"ids":["native:create_automation"]}),
        )
    } else if !done("calendar_start") {
        (
            "calendar_start",
            "start_work",
            json!({"objective":"Create the requested schedule"}),
        )
    } else if !done("calendar_plan") {
        (
            "calendar_plan",
            "replace_work_plan",
            json!({"objective":"Create the requested schedule",
            "execution_mode":"direct", "actions":[{"action_key":"schedule", "effect":{"capability":"create_automation", "target":"Requested schedule"}}],
            "checks":["The requested schedule is stored"]}),
        )
    } else if !done("calendar_review") {
        (
            "calendar_review",
            "record_work_review",
            json!({"subject":"plan", "verdict":"accept", "summary":"Plan matches the request",
            "action_updates":[{"action_key":"schedule", "status":"active"}]}),
        )
    } else if !done("calendar_tool_call") {
        (
            "calendar_tool_call",
            "tool_call",
            json!({"id":"native:create_automation", "arguments":args}),
        )
    } else if !done("calendar_close") {
        (
            "calendar_close",
            "record_work_disposition",
            json!({"work_id":work?, "disposition":"completed", "summary":"Schedule request handled",
            "action_updates":[{"action_key":"schedule", "status":"done"}]}),
        )
    } else {
        return Some(title_response("Schedule request handled."));
    };
    Some(tool_response(id, name, &arguments, body["model"].as_str()?))
}

fn work_id(value: &Value) -> Option<String> {
    value
        .get("work_id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| value.as_object()?.values().find_map(work_id))
}

fn tool_response(id: &str, name: &str, args: &Value, model: &str) -> ResponseRecord {
    let item = json!({"type":"function_call", "id":id, "call_id":id, "name":name,
        "arguments":args.to_string(), "status":"completed"});
    let events = [
        json!({"type":"response.created","response":{"id":"resp_calendar","status":"in_progress","output":[]}}),
        json!({"type":"response.output_item.added","output_index":0,"item":item}),
        json!({"type":"response.function_call_arguments.delta","item_id":id,"output_index":0,"delta":item["arguments"]}),
        json!({"type":"response.function_call_arguments.done","item_id":id,"output_index":0,"arguments":item["arguments"]}),
        json!({"type":"response.output_item.done","output_index":0,"item":item}),
        json!({"type":"response.completed","response":{"id":"resp_calendar", "object":"response", "status":"completed",
            "model":model,"output":[item],"usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120}}}),
    ];
    ResponseRecord {
        status: 200,
        headers: vec![],
        chunks: events
            .into_iter()
            .enumerate()
            .map(|(i, mut event)| {
                event["sequence_number"] = json!(i);
                Chunk {
                    delay_ms: 0,
                    text: format!(
                        "event: {}\ndata: {event}\n\n",
                        event["type"].as_str().unwrap()
                    ),
                }
            })
            .collect(),
    }
}
