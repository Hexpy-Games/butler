//! A user-started rules upgrade resumes the same shadow and retires its predecessor after seven days.
use super::{memory_response, memory_stubs};
use butler_e2e::e2e::{
    HarnessError,
    cassette::{Cassette, Chunk, ResponseRecord},
    scenario::Setup,
};
use serde_json::{Value, json};
use std::time::Duration;

#[tokio::test]
async fn mem_active_extraction_resumes_after_graceful_shutdown() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut cassette = Cassette::load("MEM-01")?;
    memory_stubs::ordinary(&mut cassette);
    let mut s = Setup::new("MEM-SHUTDOWN-RESUME")?
        .stub_cassette(cassette)
        .start()
        .await?;
    let held = s.provider()?.hold_next_reply("\"speaker\":\"user\"");
    let message = memory_stubs::ORDINARY_MESSAGES[0];
    let (turn_id, turn) = s.turn("general", message).await?;
    assert_eq!(turn["state"], "delivered");
    tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            if s.provider()?
                .memory_requests()
                .iter()
                .any(|request| request.to_string().contains(message))
            {
                return Ok::<_, HarnessError>(());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("active extraction reaches its held reply")?;
    let graph = butler_platform::sqlite::open_with_flags(
        memory_stubs::graph_path(&s.sandbox.data)?,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let window: String = graph.query_row(
        "SELECT w.window_ref FROM memory_projection_windows w JOIN memory_projection_jobs j ON j.job_id=w.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id WHERE c.source_key=?1 AND w.state='running'",
        [format!("conversation_turn:{turn_id}")],
        |row| row.get(0),
    )?;
    s.agent.terminate().await?;
    let state: String = graph.query_row(
        "SELECT state FROM memory_projection_windows WHERE window_ref=?1",
        [&window],
        |row| row.get(0),
    )?;
    assert_eq!(state, "running");
    s.gw = s.agent.start_again().await?;
    held.release();
    tokio::time::timeout(Duration::from_secs(180), async {
        loop {
            let state: String = graph.query_row(
                "SELECT state FROM memory_projection_windows WHERE window_ref=?1",
                [&window],
                |row| row.get(0),
            )?;
            if state == "complete" {
                return Ok::<_, HarnessError>(());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("interrupted active window completes after restart")?;
    drop(graph);
    s.finish().await
}

#[tokio::test]
async fn mem_reextract_rebuilds_resumes_switches_and_retires() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    const T: &str = "2026-11-20T12:00:00.000Z";
    const CHAT1: &str = "My lock word is amber.";
    const CHAT2_WORD: &str = "garnet";
    const CHAT2: &str = "My garden word is garnet.";
    const CHAT3: &str = "My travel word is cobalt.";
    let asks = [
        ("Recall my lock word.", "lock word", "amber"),
        ("Recall my travel word.", "travel word", "cobalt"),
    ];
    let mut cassette = Cassette::load("MEM-01")?;
    let mut answer = cassette.exchanges[1].clone();
    for chunk in &mut answer.response.chunks {
        chunk.text = chunk.text.replace(
            "Saved your bike lock code to explicit memory for future conversations.",
            "Noted.",
        );
    }
    for message in [CHAT1, CHAT2, CHAT3] {
        let mut exchange = cassette.exchanges[0].clone();
        exchange.request.key.user_request = message.into();
        exchange.response = answer.response.clone();
        cassette.exchanges.push(exchange);
    }
    for (ask, cue, _) in asks {
        let mut call = cassette.exchanges[0].clone();
        call.request.key.user_request = ask.into();
        call.response = memory_response(
            &json!({"type":"function_call","id":"fc_recall","call_id":"call_recall","name":"recall_memory","status":"completed","arguments":json!({"cue":cue}).to_string()}),
        );
        let mut reply = answer.clone();
        reply.request.key.user_request = ask.into();
        cassette.exchanges.extend([call, reply]);
    }
    let mut s = Setup::new("MEM-REEXTRACT")?
        .stub_cassette(cassette)
        .env("BUTLER_E2E_APP_NOW", T)
        .start()
        .await?;
    s.provider()?
        .set_chat_responder(memory_stubs::daily_briefing);
    s.provider()?.set_memory_responder(|_| {
        let text = json!({"status":"processed","entities":[],"items":[],"attributes":[]}).to_string();
        let item = json!({"type":"message","id":"msg_meaning","role":"assistant","status":"completed","content":[{"type":"output_text","text":text,"annotations":[]}]});
        let events = [
            json!({"type":"response.created","response":{"id":"resp_meaning","status":"in_progress","output":[]}}),
            json!({"type":"response.output_item.added","output_index":0,"item":item}),
            json!({"type":"response.output_text.delta","item_id":"msg_meaning","output_index":0,"content_index":0,"delta":text}),
            json!({"type":"response.output_item.done","output_index":0,"item":item}),
            json!({"type":"response.completed","response":{"id":"resp_meaning","object":"response","status":"completed","model":"gpt-6-luna","output":[item],"usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120}}}),
        ];
        ResponseRecord {
            status: 200, headers: vec![],
            chunks: events.into_iter().enumerate().map(|(index, mut event)| {
                event["sequence_number"] = json!(index);
                Chunk { delay_ms: 0, text: format!("event: {}\ndata: {event}\n\n", event["type"].as_str().unwrap()) }
            }).collect(),
        }
    });
    let chat =
        s.gw.post("/sessions", json!({"kind":"chat","title":"Second chat"}))
            .await?;
    assert_eq!(chat.status, 201, "{}", chat.text);
    let chat2 = chat.data()["session"]["id"].as_str().unwrap();
    assert_eq!(s.turn("general", CHAT1).await?.1["state"], "delivered");
    assert_eq!(s.turn(chat2, CHAT2).await?.1["state"], "delivered");
    memory_stubs::text_complete(&s.sandbox.data, 2).await?;
    let checked = s.gw.post("/memory/inventory/check", json!({})).await?;
    assert_eq!(checked.data()["reextract_available"], false);
    let rejected = s
        .gw
        .post(
            "/memory/reset/reextract",
            json!({"operation_id":uuid::Uuid::new_v4().to_string(),"inventory_revision":checked.data()["revision"]}),
        )
        .await?;
    assert_eq!(rejected.status, 409, "{}", rejected.text);
    let memory = s.sandbox.data.join("cognition/memory");
    assert!(!memory.join("management/resets").exists());
    let read_json = |path: &std::path::Path| -> Result<Value, HarnessError> {
        Ok(serde_json::from_slice(&std::fs::read(path)?)?)
    };
    let active = read_json(&memory.join("active-generation.json"))?;
    let old = memory
        .join("generations")
        .join(active["generation_id"].as_str().unwrap());
    s.agent.terminate().await?;
    let mut manifest = read_json(&old.join("manifest.json"))?;
    manifest
        .as_object_mut()
        .unwrap()
        .remove("extraction_rules_version");
    std::fs::write(old.join("manifest.json"), serde_json::to_vec(&manifest)?)?;
    let g1 = s.provider()?.hold_next_reply(CHAT2_WORD);
    let before = s.provider()?.memory_requests().len();
    s.gw = s.agent.start_again().await?;
    let checked = s.gw.post("/memory/inventory/check", json!({})).await?;
    assert_eq!(checked.data()["reextract_available"], true);
    assert!(!memory.join("management/resets").exists());
    let accepted = s
        .gw
        .post(
            "/memory/reset/reextract",
            json!({"operation_id":uuid::Uuid::new_v4().to_string(),"inventory_revision":checked.data()["revision"]}),
        )
        .await?;
    assert_eq!(accepted.status, 202, "{}", accepted.text);
    assert_eq!(accepted.data()["kind"], "reextract");
    assert_eq!(accepted.data()["phase"], "preparing");
    let id = accepted.data()["operation_id"].as_str().unwrap();
    tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            let inventory = s.gw.get("/memory/inventory").await?;
            let operation = &inventory.data()["operation"];
            if operation["kind"] == "reextract"
                && operation["phase"] == "preparing"
                && operation["done"].as_u64().is_some_and(|done| {
                    operation["total"]
                        .as_u64()
                        .is_some_and(|total| total == 2 && done < total)
                })
                && s.provider()?.memory_requests()[before..]
                    .iter()
                    .any(|request| request.to_string().contains(CHAT2_WORD))
            {
                return Ok::<_, HarnessError>(operation.clone());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("re-extraction reaches its held second chat")?;
    s.agent.terminate().await?;
    drop(g1);
    let g2 = s.provider()?.hold_next_reply(CHAT2_WORD);
    let before = s.provider()?.memory_requests().len();
    s.gw = s.agent.start_again().await?;
    tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            if s.provider()?.memory_requests()[before..]
                .iter()
                .any(|request| request.to_string().contains(CHAT2_WORD))
            {
                return Ok::<_, HarnessError>(());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("interrupted window retries after restart")?;
    let resumed = s.gw.get(&format!("/memory/reset/{id}")).await?;
    assert_eq!(resumed.data()["operation_id"], id);
    assert_eq!(resumed.data()["phase"], "preparing");
    assert_eq!(s.turn("general", CHAT3).await?.1["state"], "delivered");
    g2.release();
    let complete = tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            let reply = s.gw.get(&format!("/memory/reset/{id}")).await?;
            assert_ne!(reply.data()["phase"], "failed", "{}", reply.text);
            if reply.data()["phase"] == "complete" {
                return Ok::<_, HarnessError>(reply.data().clone());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("re-extraction completes")?;
    let active = read_json(&memory.join("active-generation.json"))?;
    assert_eq!(active["generation_id"], id);
    assert!(active["previous_generation_id"].is_null());
    let graph = memory.join("generations").join(id).join("graph.sqlite");
    let count: u64 = butler_platform::sqlite::open_with_flags(
        graph,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?
    .query_row(
        "SELECT COUNT(*) FROM memory_chunks WHERE source_key LIKE 'conversation_turn:%'",
        [],
        |row| row.get(0),
    )?;
    assert_eq!(count, 3);
    let checked = s.gw.post("/memory/inventory/check", json!({})).await?;
    assert_eq!(checked.data()["reextract_available"], false);
    for (ask, _, word) in asks {
        let chat =
            s.gw.post("/sessions", json!({"kind":"chat","title":"Recall"}))
                .await?;
        assert_eq!(chat.status, 201, "{}", chat.text);
        let first = s.provider()?.requests().len();
        assert_eq!(
            s.turn(chat.data()["session"]["id"].as_str().unwrap(), ask)
                .await?
                .1["state"],
            "delivered"
        );
        let requests = s.provider()?.requests();
        let output = requests[first..]
            .iter()
            .filter_map(|r| r["input"].as_array())
            .flatten()
            .find(|item| item["type"] == "function_call_output")
            .unwrap()["output"]
            .as_str()
            .unwrap();
        let result: Value = serde_json::from_str(output)?;
        assert_eq!(result["ok"], true, "{output}");
        assert!(output.contains(word), "{output}");
    }
    assert!(old.is_dir());
    assert_eq!(read_json(&old.join("manifest.json"))?["state"], "retired");
    assert_eq!(complete["removal_pending"], true);
    assert_eq!(complete["retire_after"], "2026-11-27T12:00:00.000Z");
    s.agent.terminate().await?;
    // The fixed clock stays 10 s before retire_after, so no startup pass is due; only the in-process hold timer can reclaim the generation.
    s.agent
        .launch
        .set_env("BUTLER_E2E_APP_NOW", "2026-11-27T11:59:50.000Z");
    s.gw = s.agent.start_again().await?;
    tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            let reply = s.gw.get(&format!("/memory/reset/{id}")).await?;
            if reply.data()["removal_pending"] == false && !old.exists() {
                return Ok::<_, HarnessError>(());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("retired generation is reclaimed by the in-process hold timer")?;
    s.finish().await
}
