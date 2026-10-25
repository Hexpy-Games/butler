//! Container correction stays model-private; closed children arrive before container close.
use super::*;

fn spec() -> Value {
    let fixture: Value =
        serde_json::from_str(include_str!("../answer_blocks/fixtures.json")).unwrap();
    let mut spec = fixture["specs"]["v2"].clone();
    // Collected nested images are exercised by browser_delegation::answer.
    spec["blocks"][1]["tabs"][1]["blocks"][0] = json!({"type":"text","text":"Picture details"});
    spec["blocks"][0]["blocks"][0]["items"][0]["text"] = json!("청자 panorama details");
    spec
}

fn recording() -> Result<Cassette, HarnessError> {
    let mut c = Cassette::load("TOOL-01")?;
    let template = c.exchanges[0].clone();
    c.exchanges.clear();
    let mut invalid = spec();
    invalid["blocks"][0]["blocks"][0] =
        json!({"type":"group","blocks":[{"type":"text","text":"Nested"}]});
    invalid["blocks"][1]["tabs"][0]["blocks"][0]["items"][0]["value"] = json!(101);
    for (step, spec) in [Some(invalid), Some(spec()), None].into_iter().enumerate() {
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

#[tokio::test]
async fn containers_correct_and_stream_closed_children() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("ANSWER-BLOCKS-V2")?
        .stub_cassette(recording()?)
        .start()
        .await?;
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    let (turn_id, turn) = s.turn("general", PROMPT).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}\n{}", s.agent.logs());
    let messages = s.gw.messages("general").await?;
    let reply = messages
        .iter()
        .find(|m| m["role"] == "assistant" && m["turn_id"] == turn_id)
        .unwrap();
    let mut expected = spec();
    butler_runtime::capabilities::answer_blocks::normalize(&mut expected);
    assert_eq!(reply["answer_blocks"][0]["spec"], expected);
    assert!(!json!(messages).to_string().contains("invalid_blocks"));
    let db = rusqlite::Connection::open_with_flags(
        s.sandbox.data.join("agent-runtime/btcc.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let rejected: String = db.query_row("SELECT result_json FROM btcc_guided_tool_calls WHERE turn_id=?1 AND tool_name='answer_blocks' ORDER BY rowid LIMIT 1", [&turn_id], |r| r.get(0))?;
    let rejected: Value = serde_json::from_str(&rejected)?;
    let problems = rejected["error"]["problems"].as_array().unwrap();
    assert!(problems.iter().any(|p| p["path"] == "/blocks/0/blocks/0"
        && p["fix"].as_str().unwrap().contains("containers never nest")));
    assert!(
        problems
            .iter()
            .any(|p| p["path"] == "/blocks/1/tabs/0/blocks/0/items/0/value")
    );
    live.wait_for(std::time::Duration::from_secs(10), |event| {
        event["type"] == "answer_blocks.draft"
            && event["payload"]["ops"]
                .as_array()
                .is_some_and(|ops| ops.iter().any(|op| op["op"] == "child"))
    })
    .await?;
    let ops: Vec<Value> = live
        .snapshot()
        .iter()
        .filter(|event| event["type"] == "answer_blocks.draft")
        .flat_map(|event| event["payload"]["ops"].as_array().unwrap().clone())
        .collect();
    let child = ops
        .iter()
        .position(|op| op["op"] == "child" && op["bi"] == 1 && op["tab"] == 0 && op["index"] == 0)
        .unwrap();
    let tab = ops
        .iter()
        .enumerate()
        .skip(child + 1)
        .position(|(_, op)| op["op"] == "item" && op["bi"] == 1 && op["list"] == "tabs");
    assert!(tab.is_some(), "a child closes before its tab unit");
    drop((live, db));
    s.finish().await
}

#[tokio::test]
async fn block_scraps_are_frozen_searchable_and_paths_are_checked() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BLOCK-SCRAPS")?
        .stub_cassette(recording()?)
        .start()
        .await?;
    let (_, turn) = s.turn("general", PROMPT).await?;
    assert_eq!(turn_state(&turn), "delivered");
    let messages = s.gw.messages("general").await?;
    let reply = messages.iter().find(|m| m["role"] == "assistant").unwrap();
    let user = messages.iter().find(|m| m["role"] == "user").unwrap();
    let mut expected = spec();
    butler_runtime::capabilities::answer_blocks::normalize(&mut expected);
    for (path, block) in [
        ("/blocks/0", &expected["blocks"][0]),
        ("/blocks/0/blocks/0", &expected["blocks"][0]["blocks"][0]),
    ] {
        let input =
            json!({"message_id":reply["id"],"path":path,"block":{"type":"text","text":"forged"}});
        let saved = s.gw.post("/library/blocks", input.clone()).await?;
        assert_eq!(saved.status, 200, "{}", saved.text);
        let item = saved.data();
        assert_eq!(item["kind"], "scrap");
        assert_eq!(item["block"], json!({"v":2,"blocks":[block]}));
        assert_eq!(item["origin"]["session"], "general");
        assert_eq!(item["origin"]["message"], reply["id"]);
        assert_eq!(item["origin"]["path"], path);
        assert_eq!(item["origin"].get("id"), block.get("id"));
        assert!(item["capturedAt"].is_string());
        assert_eq!(s.gw.post("/library/blocks", input).await?.data(), item);
        let id = item["id"].as_str().unwrap();
        assert_eq!(s.gw.get(&format!("/library/{id}")).await?.data(), item);
    }
    for word in ["청자", "panorama"] {
        let query: String = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("q", word)
            .finish();
        let found = s.gw.get(&format!("/library?kind=scrap&{query}")).await?;
        assert_eq!(found.data()["items"].as_array().unwrap().len(), 2);
    }
    for path in [
        "/blocks/0/text",
        "/blocks/00",
        "/blocks/99",
        "/blocks/0/blocks/0/text",
        "/blocks/1/tabs/0",
        "",
    ] {
        assert_eq!(
            s.gw.post(
                "/library/blocks",
                json!({"message_id":reply["id"],"path":path})
            )
            .await?
            .status,
            400,
            "{path}"
        );
    }
    assert_eq!(
        s.gw.post(
            "/library/blocks",
            json!({"message_id":user["id"],"path":"/blocks/0"})
        )
        .await?
        .status,
        400
    );
    s.finish().await
}
