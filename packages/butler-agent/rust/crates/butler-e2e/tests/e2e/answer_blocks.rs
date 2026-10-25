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
    expected["blocks"][0]["media"] = json!("1:1");
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
    for outcome in ["rejected", "accepted"] {
        live.wait_for(std::time::Duration::from_secs(10), |event| {
            event["type"] == "answer_blocks.draft"
                && event["payload"]["ops"].as_array().is_some_and(|ops| {
                    ops.iter()
                        .any(|op| op["op"] == "end" && op["outcome"] == outcome)
                })
        })
        .await?;
    }
    for frame in live
        .snapshot()
        .iter()
        .filter(|frame| frame["type"] == "answer_blocks.draft")
    {
        assert!(frame.get("id").is_none());
        for op in frame["payload"]["ops"].as_array().unwrap() {
            assert!(op["seq"].is_u64());
            assert!(op.get("arguments").is_none());
        }
    }
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
    assert!(
        problems.iter().any(|p| p["path"] == "/blocks/1/rows/0/0"
            && p["fix"].as_str().unwrap().contains("at most 60"))
    );
    assert!(
        s.provider()?
            .requests()
            .iter()
            .any(|request| request.to_string().contains("at most 60")),
        "cell correction must reach the model"
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
    invalid["blocks"]
        .as_array_mut()
        .unwrap()
        .push(json!({"type":"table",
        "columns":["Method","Notes"],"rows":[["x".repeat(61),"Complete input"]]}));

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
        exchange.response = response(&item);
        c.exchanges.push(exchange);
    }
    Ok(c)
}

fn response(item: &Value) -> ResponseRecord {
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

#[tokio::test]
async fn draft_is_ephemeral_and_reconnects_once() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut recording = cassette()?;
    // Start with the accepted spec and hold the provider between its closed items.
    recording.exchanges.remove(0);
    recording.exchanges[0].request.key.round.clear();
    recording.exchanges[1].request.key.round =
        vec!["function_call".into(), "function_call_output".into()];
    let chunks = &mut recording.exchanges[0].response.chunks;
    let delta = chunks[2].text.clone();
    let data = delta
        .lines()
        .find_map(|line| line.strip_prefix("data: "))
        .unwrap();
    let event: Value = serde_json::from_str(data)?;
    let spec: Value = serde_json::from_str(event["delta"].as_str().unwrap())?;
    let items = &spec["blocks"][0]["items"];
    let arguments = format!(
        "{{\"v\":1,\"blocks\":[{{\"type\":\"cards\",\"id\":\"methods\",\"items\":[{},{}]}}]}}",
        items[0], items[1]
    );
    let split = arguments.find("},{").unwrap() + 1;
    let mut first = event.clone();
    first["delta"] = json!(&arguments[..split]);
    let mut second = event;
    second["delta"] = json!(&arguments[split..]);
    chunks[2].text = format!("data: {first}\n\n");
    chunks[2].delay_ms = 300;
    chunks.insert(
        3,
        Chunk {
            delay_ms: 1500,
            text: format!("data: {second}\n\n"),
        },
    );
    chunks[4].delay_ms = 1500;
    let s = Setup::new("ANSWER-DRAFT-EPHEMERAL")?
        .stub_cassette(recording)
        .start()
        .await?;
    s.provider()?.set_pacing(butler_e2e::e2e::provider::Pacing {
        scale: 1.0,
        cap_ms: 1500,
        min_ms: 0,
    });
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    s.gw.say("general", PROMPT).await?;
    let first = live
        .wait_for(std::time::Duration::from_secs(20), |event| {
            event["type"] == "answer_blocks.draft"
                && event["payload"]["ops"]
                    .as_array()
                    .is_some_and(|ops| ops.iter().any(|op| op["op"] == "item" && op["index"] == 0))
        })
        .await?;
    assert!(first.get("id").is_none());
    let turn = first["payload"]["turn_id"].as_str().unwrap();
    let before = draft_row_counts(&s, turn)?;
    assert_eq!(before, (0, 0), "first draft must not write durable rows");
    let reconnect = LiveEvents::subscribe(&s.gw, 0).await?;
    let snapshot = reconnect
        .wait_for(std::time::Duration::from_secs(10), |event| {
            event["type"] == "answer_blocks.snapshot"
        })
        .await?;
    assert!(snapshot.get("id").is_none());
    let drafts = snapshot["payload"]["drafts"].as_array().unwrap();
    assert_eq!(drafts.len(), 1);
    assert!(
        drafts[0]["ops"]
            .as_array()
            .unwrap()
            .iter()
            .any(|op| op["op"] == "item" && op["index"] == 0)
    );
    let second = live
        .wait_for(std::time::Duration::from_secs(10), |event| {
            event["type"] == "answer_blocks.draft"
                && event["payload"]["ops"]
                    .as_array()
                    .is_some_and(|ops| ops.iter().any(|op| op["op"] == "item" && op["index"] == 1))
        })
        .await?;
    assert!(second.get("id").is_none());
    let after = draft_row_counts(&s, turn)?;
    assert_eq!(after, (0, 0), "draft units must not write durable rows");
    eprintln!("draft row counts before={before:?} after={after:?}; reconnect snapshots=1");
    assert_eq!(
        reconnect
            .snapshot()
            .iter()
            .filter(|event| event["type"] == "answer_blocks.snapshot")
            .count(),
        1
    );
    s.gw.wait_turn(
        "general",
        turn,
        &["delivered"],
        std::time::Duration::from_secs(20),
    )
    .await?;
    assert_eq!(
        draft_row_counts(&s, turn)?,
        (0, 1),
        "delivery must persist one assistant message and no draft events"
    );
    let final_messages = s.gw.messages("general").await?;
    assert!(
        final_messages
            .iter()
            .any(|message| message["answer_blocks"].is_array())
    );
    let ended = LiveEvents::subscribe(&s.gw, 0).await?;
    let snapshot = ended
        .wait_for(std::time::Duration::from_secs(10), |event| {
            event["type"] == "answer_blocks.snapshot"
        })
        .await?;
    assert_eq!(snapshot["payload"]["drafts"], json!([]));
    drop((live, reconnect, ended));
    s.finish().await
}

fn draft_row_counts(
    s: &butler_e2e::e2e::scenario::Scenario,
    turn: &str,
) -> Result<(i64, i64), HarnessError> {
    let db = rusqlite::Connection::open_with_flags(
        s.sandbox.data.join("app-server/butler-client.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    // Durable progress can still catch up while ephemeral drafts are published.
    // Count only draft events and this turn's assistant rows, not that progress.
    Ok((
        db.query_row(
            "SELECT COUNT(*) FROM events \
             WHERE type IN ('answer_blocks.draft', 'answer_blocks.snapshot')",
            [],
            |row| row.get(0),
        )?,
        db.query_row(
            "SELECT COUNT(*) FROM app_owned_messages WHERE turn_id=?1 AND role='assistant'",
            [turn],
            |row| row.get(0),
        )?,
    ))
}

#[path = "answer_blocks_v2.rs"]
mod v2;

#[tokio::test]
async fn image_geometry_is_projected_from_asset_pixel_ratio() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("ANSWER-IMAGE-GEOMETRY")?
        .stub_cassette(cassette()?)
        .start()
        .await?;
    let (_, turn) = s.turn("general", PROMPT).await?;
    assert_eq!(turn_state(&turn), "delivered");
    let db = rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    for (id, width, height, ratio) in [
        ("img_small12080", 120, 80, 1.0),
        ("img_large30000", 3000, 2000, 2.0),
    ] {
        db.execute("INSERT INTO app_assets(id,sha256,mime,width,height,bytes,alt,source_url,created_at,pixel_ratio) VALUES(?1,?1,'image/png',?2,?3,0,'','','2026-10-25',?4)", rusqlite::params![id,width,height,ratio])?;
    }
    let spec = json!({"v":2,"blocks":[{"type":"image","img":"img_small12080"},{"type":"columns","blocks":[{"type":"image","img":"img_large30000"}]}]});
    let sets = json!([{"call_id":"geometry","set_ids":[],"spec":spec}]);
    db.execute(
        "UPDATE messages SET blocks_json=?1 WHERE role='assistant' AND status='delivered'",
        [sets.to_string()],
    )?;
    let messages = s.gw.messages("general").await?;
    let reply = messages
        .iter()
        .find(|m| m["role"] == "assistant" && m["status"] == "delivered")
        .unwrap();
    let blocks = &reply["answer_blocks"][0]["spec"]["blocks"];
    assert_eq!(
        (
            blocks[0]["image_width"].clone(),
            blocks[0]["image_height"].clone()
        ),
        (json!(120.0), json!(80.0))
    );
    let large = &blocks[1]["blocks"][0];
    assert_eq!(
        (large["image_width"].clone(), large["image_height"].clone()),
        (json!(1500.0), json!(1000.0))
    );
    assert!(large["image_url"].as_str().unwrap().contains("signature="));
    drop(db);
    s.restart().await?;
    let view = s.gw.get("/session-view?session_id=general").await?;
    assert!(view.data().to_string().contains("\"image_width\":1500.0"));
    s.finish().await
}
