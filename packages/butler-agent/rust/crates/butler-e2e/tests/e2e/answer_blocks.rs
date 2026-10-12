//! Structured-answer correction and durable reopening through the real App gateway.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E assertions")]
use butler_e2e::e2e::{
    HarnessError,
    cassette::{Cassette, Chunk, ResponseRecord},
    events::LiveEvents,
    gateway::turn_state,
    scenario::Setup,
};
use serde_json::{Value, json};

const PROMPT: &str = "Show the two methods as structured records.";

#[tokio::test]
async fn invalid_blocks_corrected_and_reopened() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("ANSWER-BLOCKS-TOOL")?
        .stub_cassette(cassette()?)
        .start()
        .await?;
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    let (id, turn) = s.turn("general", PROMPT).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}\n{}", s.agent.logs());
    let messages = s.gw.messages("general").await?;
    let reply = messages
        .iter()
        .find(|m| m["role"] == "assistant" && m["turn_id"] == id && m["status"] == "delivered")
        .unwrap();
    let sets = reply["answer_blocks"].clone();
    assert_eq!(sets.as_array().unwrap().len(), 1);
    let mut expected = corrected();
    expected["blocks"][0]["media"] = json!("4:5");
    expected["blocks"][0]["items"][0]["title"] = json!("Method A");
    assert_eq!(sets[0]["spec"], expected);
    assert_eq!(sets[0]["set_ids"], json!(["methods"]));
    assert!(!reply["text"].as_str().unwrap().contains("invalid_blocks"));
    assert!(!json!(messages).to_string().contains("invalid_blocks"));
    let updated = live
        .wait_for(std::time::Duration::from_secs(10), |event| {
            event["type"] == "message.updated"
                && event["payload"]["message"]["id"] == reply["id"]
                && event["payload"]["message"]["answer_blocks"].is_array()
        })
        .await?;
    assert_eq!(updated["payload"]["message"]["answer_blocks"], sets);
    drop(live);
    assert_feedback(&s, &id)?;
    s.restart().await?;
    let view = s.gw.get("/session-view?session_id=general").await?;
    let reopened = view.data()["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == reply["id"])
        .unwrap()
        .clone();
    assert_eq!(reopened["answer_blocks"], sets);
    s.finish().await
}

fn assert_feedback(
    s: &butler_e2e::e2e::scenario::Scenario,
    turn: &str,
) -> Result<(), HarnessError> {
    let db = rusqlite::Connection::open_with_flags(
        s.sandbox.data.join("agent-runtime/btcc.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let mut query = db.prepare("SELECT result_json FROM btcc_guided_tool_calls WHERE turn_id=?1 AND tool_name='answer_blocks' ORDER BY rowid")?;
    let results = query
        .query_map([turn], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    assert_eq!(results.len(), 2);
    let rejected: Value = serde_json::from_str(&results[0])?;
    assert_eq!(rejected["ok"], false);
    assert_eq!(rejected["error"]["code"], "invalid_blocks");
    let problems = rejected["error"]["problems"].as_array().unwrap();
    assert!(
        problems
            .iter()
            .any(|p| p["path"] == "/v" && p["fix"].is_string())
    );
    assert!(
        problems
            .iter()
            .any(|p| p["path"] == "/blocks/0/items/0/source"
                && p["fix"].as_str().unwrap().contains("not opened"))
    );
    let accepted: Value = serde_json::from_str(&results[1])?;
    assert_eq!(accepted, json!({"ok":true,"shown":{"cards":2}}));
    Ok(())
}

fn corrected() -> Value {
    json!({"v":1,"blocks":[{"type":"cards","id":"methods","items":[
        {"title":" Method A ","text":"First method."}, {"title":"Method B","text":"Second method."}]}]})
}

fn cassette() -> Result<Cassette, HarnessError> {
    let mut c = Cassette::load("TOOL-01")?;
    let template = c.exchanges[0].clone();
    c.exchanges.clear();
    let mut invalid = corrected();
    invalid.as_object_mut().unwrap().remove("v");
    invalid["blocks"][0]["items"][0]["value"] = json!({"amount":2,"unit":"steps"});
    invalid["blocks"][0]["items"][0]["source"] = json!("https://example.org/methods");
    invalid["blocks"][0]["items"][0]["checked"] = json!(chrono::Utc::now().to_rfc3339());
    for (step, spec) in [Some(invalid), Some(corrected()), None]
        .into_iter()
        .enumerate()
    {
        let mut exchange = template.clone();
        exchange.request.key.user_request = PROMPT.into();
        exchange.request.key.round = (0..step)
            .flat_map(|_| ["function_call".into(), "function_call_output".into()])
            .collect();
        let item = match spec {
            Some(spec) => {
                json!({"type":"function_call","id":format!("fc_{step}"),"call_id":format!("call_{step}"),"name":"answer_blocks","arguments":spec.to_string(),"status":"completed"})
            }
            None => {
                json!({"type":"message","id":"msg_final","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Two methods are ready.","annotations":[]}]})
            }
        };
        exchange.response = response(item);
        c.exchanges.push(exchange);
    }
    Ok(c)
}

fn response(item: Value) -> ResponseRecord {
    let mut events = vec![
        json!({"type":"response.created","response":{"id":"resp_blocks","status":"in_progress","output":[]}}),
        json!({"type":"response.output_item.added","output_index":0,"item":item}),
    ];
    if item["type"] == "function_call" {
        events.push(json!({"type":"response.function_call_arguments.delta","item_id":item["id"],"output_index":0,"delta":item["arguments"]}));
        events.push(json!({"type":"response.function_call_arguments.done","item_id":item["id"],"output_index":0,"arguments":item["arguments"]}));
    } else {
        events.push(json!({"type":"response.output_text.delta","item_id":item["id"],"output_index":0,"content_index":0,"delta":"Two methods are ready."}));
    }
    events.push(json!({"type":"response.output_item.done","output_index":0,"item":item}));
    events.push(json!({"type":"response.completed","response":{"id":"resp_blocks","object":"response","status":"completed","model":"gpt-6-luna","output":[item],"usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120}}}));
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
