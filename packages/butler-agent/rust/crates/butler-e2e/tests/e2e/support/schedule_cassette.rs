//! Synthetic schedule replay derived from the existing TOOL-02 wire stream.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test fixture assertions"
)]
use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::cassette::{Cassette, ResponseRecord};
use serde_json::{Value, json};

pub(super) const CHAT_REQUEST: &str =
    "Create a 60-minute schedule titled Chat schedule to summarize today's changes.";

pub(super) fn stub_schedule_cassette() -> Result<Cassette, HarnessError> {
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
        if event.get("item_id").is_some() {
            event["item_id"] = format!("fc_schedule_{name}").into();
        }
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
                object.insert("id".into(), format!("fc_schedule_{name}").into());
                object.insert("call_id".into(), format!("call_schedule_{name}").into());
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

pub(super) fn discovery_cassette(
    ask: &str,
    name: &str,
    arguments: &Value,
    work_echo: usize,
) -> Result<Cassette, HarnessError> {
    let mut c = stub_schedule_cassette()?;
    rewrite_tool_call(
        &mut c.exchanges[0].response,
        "start_work",
        &json!({"objective":ask}),
    )?;
    rewrite_tool_call(
        &mut c.exchanges[1].response,
        "replace_work_plan",
        &json!({
            "objective":ask, "execution_mode":"direct",
            "actions":[{"action_key":name, "effect":{"capability":name, "target":"Requested schedule"}}],
            "checks":["The requested schedule state is persisted."]
        }),
    )?;
    rewrite_tool_call(
        &mut c.exchanges[2].response,
        "record_work_review",
        &json!({
            "subject":"plan", "verdict":"accept", "summary":"The plan covers the requested schedule operation.",
            "action_updates":[{"action_key":name, "status":"active"}]
        }),
    )?;
    let mut disposition = tool_arguments(&c.exchanges[4].response)?;
    // Each chat turn binds a new Work; echo its own id from provider input.
    disposition["work_id"] = format!("{{{{ECHO_{work_echo}}}}}").into();
    disposition["summary"] = "Completed the requested schedule operation.".into();
    disposition["action_updates"] = json!([{"action_key":name, "status":"done"}]);
    rewrite_tool_call(
        &mut c.exchanges[4].response,
        "record_work_disposition",
        &disposition,
    )?;
    for chunk in &mut c.exchanges[5].response.chunks {
        chunk.text = chunk
            .text
            .replace("Created the schedule.", "Processed the schedule.");
    }

    let mut search = c.exchanges[0].clone();
    rewrite_tool_call(
        &mut search.response,
        "tool_search",
        &json!({"query":"schedule"}),
    )?;
    let mut describe = search.clone();
    describe.request.key.round = vec!["function_call".into(), "function_call_output".into()];
    rewrite_tool_call(
        &mut describe.response,
        "tool_describe",
        &json!({"ids":[
            "native:create_automation", "native:list_automations",
            "native:update_automation", "native:delete_automation"
        ]}),
    )?;
    rewrite_tool_call(
        &mut c.exchanges[3].response,
        "tool_call",
        &json!({
            "id":format!("native:{name}"), "arguments":arguments
        }),
    )?;
    for exchange in &mut c.exchanges {
        let prefix = [
            "function_call",
            "function_call_output",
            "function_call",
            "function_call_output",
        ];
        exchange
            .request
            .key
            .round
            .splice(0..0, prefix.map(str::to_owned));
    }
    c.exchanges.splice(0..0, [search, describe]);
    for exchange in &mut c.exchanges {
        exchange.request.key.user_request = ask.into();
    }
    Ok(c)
}

/// Verify the inner capability using its public result, independently of the outer bridge label.
pub(super) async fn bridge_result(
    s: &butler_e2e::e2e::scenario::Scenario,
    turn: &str,
    name: &str,
) -> Result<Value, HarnessError> {
    let rows = butler_e2e::e2e::gateway::tool_rows(&s.gw.messages("general").await?, turn);
    let row = rows
        .iter()
        .find(|row| {
            row["tool_call_id"]
                .as_str()
                .is_some_and(|id| id.ends_with("_tool_call"))
        })
        .expect("bridge operation row");
    assert_eq!(row["state"], "delivered", "{row}");
    let output: Value = serde_json::from_str(&s.gw.operation_output(turn, row).await?)?;
    assert_eq!(output["bridge_invocation"]["id"], format!("native:{name}"));
    assert_eq!(output["ok"], true, "{output}");
    Ok(output)
}
