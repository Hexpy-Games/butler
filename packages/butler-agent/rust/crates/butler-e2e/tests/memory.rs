//! Explicit memory written by a chat survives restart.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::gateway::{tool_rows, turn_state};
use butler_e2e::e2e::scenario::{Scenario, Setup};
use butler_e2e::e2e::{HarnessError, fixtures, nonce};
use serde_json::Value;
#[path = "memory/stubs.rs"]
mod memory_stubs;

fn recalled(result: &Value, needle: &str) -> bool {
    result.to_string().contains(needle)
}
fn stored_rules(s: &Scenario, _cue: &str) -> Result<Value, HarnessError> {
    let root = s.sandbox.data.join("cognition/memory/rules");
    let mut texts = Vec::new();
    for entry in std::fs::read_dir(root)? {
        let path = entry?.path();
        if path.extension().is_some_and(|ext| ext == "md") {
            texts.push(std::fs::read_to_string(path)?);
        }
    }
    Ok(serde_json::json!(texts))
}

#[tokio::test]
async fn mem_01_chat_memory_source_survives_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let code = nonce();
    let mut cassette = butler_e2e::e2e::cassette::Cassette::load("MEM-01")?;
    memory_stubs::extraction(&mut cassette, "")?;
    let setup = Setup::new("MEM-01")?
        .stub_cassette(cassette)
        .placeholder("NONCE", &code);
    fixtures::embedding_assets(&setup.sandbox.data)?;
    let mut s = setup.start().await?;
    let (turn_id, turn) = s
        .turn(
            "general",
            &format!(
                "Please save this as a durable explicit memory so you remember it in future conversations: my bike lock code is {code}. Use your explicit memory tool, then confirm in one short sentence."
            ),
        )
        .await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let rows = tool_rows(&s.gw.messages("general").await?, &turn_id);
    let write = rows
        .iter()
        .find(|row| {
            row.to_string().contains("update_explicit_memory") && row["state"] == "delivered"
        })
        .unwrap_or_else(|| panic!("no delivered explicit memory write: {rows:#?}"));
    let output = s.gw.operation_output(&turn_id, write).await?;
    let root = s.sandbox.root.display().to_string();
    assert!(
        !output.contains(&root),
        "memory tool result shows a private path: {output}"
    );
    assert!(
        !output.contains("job_id"),
        "memory tool result shows a job id: {output}"
    );

    let result = stored_rules(&s, "bike lock code")?;
    assert!(
        recalled(&result, &code),
        "remembered fact not recalled: {result}"
    );
    s.restart().await?;
    let result = stored_rules(&s, "bike lock code")?;
    assert!(
        recalled(&result, &code),
        "recall lost across restart: {result}"
    );
    s.finish().await
}

#[tokio::test]
async fn mem_02_fresh_memory_is_usable_in_another_chat_after_restart() -> Result<(), HarnessError> {
    use butler_e2e::e2e::cassette::Cassette;
    use serde_json::json;
    butler_e2e::gate!();
    let code = nonce();
    let mut cassette = Cassette::load("MEM-01")?;
    let remember = cassette.exchanges[0].request.key.user_request.clone();
    let ask = "What is my bike lock code? Call recall_memory with cue bike lock code.";
    let mut call = cassette.exchanges[0].clone();
    call.request.key.user_request = ask.into();
    call.response = memory_response(&json!({"type":"function_call","id":"fc_recall",
        "call_id":"call_recall","name":"recall_memory","status":"completed",
        "arguments":json!({"cue":"bike lock code"}).to_string()}));
    let mut answer = cassette.exchanges[1].clone();
    answer.request.key.user_request = ask.into();
    cassette.exchanges.extend([call, answer]);
    memory_stubs::extraction(&mut cassette, ask)?;
    let setup = Setup::new("MEM-02")?
        .stub_cassette(cassette)
        .placeholder("NONCE", &code);
    assert!(
        !setup
            .sandbox
            .data
            .join("cognition/memory/active-generation.json")
            .exists()
    );
    let mut s = setup.start().await?;
    let (_, turn) = s
        .turn("general", &remember.replace("{{NONCE}}", &code))
        .await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    assert!(recalled(&stored_rules(&s, "bike lock code")?, &code));
    let descriptor = s
        .sandbox
        .data
        .join("cognition/memory/active-generation.json");
    let before = std::fs::read(&descriptor).ok();
    s.restart().await?;
    let chat =
        s.gw.post("/sessions", json!({"kind":"chat","title":"Memory B"}))
            .await?;
    assert_eq!(chat.status, 201, "{}", chat.text);
    let chat = chat.data()["session"]["id"].as_str().unwrap();
    let first = s.provider()?.requests().len();
    let (id, turn) = s.turn(chat, ask).await?;
    let requests = s.provider()?.requests();
    let first = (first..requests.len())
        .find(|&i| requests[i]["reasoning"]["effort"] == "max")
        .unwrap();
    let prompt = requests[first]["input"].to_string();
    let active_rules = prompt
        .split("## Active Rules")
        .nth(1)
        .and_then(|section| section.split("\\n## ").next())
        .is_some_and(|section| section.contains(&code));
    let rows = tool_rows(&s.gw.messages(chat).await?, &id);
    let recall = rows
        .iter()
        .find(|row| row.to_string().contains("recall_memory"))
        .unwrap_or_else(|| panic!("no recall call: {rows:?}"));
    let output = requests[first + 1..]
        .iter()
        .filter_map(|request| request["input"].as_array())
        .flatten()
        .find(|item| item["type"] == "function_call_output")
        .unwrap()["output"]
        .as_str()
        .unwrap()
        .to_owned();
    let result: Value = serde_json::from_str(&output)?;
    eprintln!(
        "MEM-02: rules=cognition/memory/rules; Active Rules fact={active_rules}; active-generation={}; recall_ok={}; recalled_fact={}; vectors={}",
        descriptor.exists(),
        result["ok"],
        output.contains(&code),
        result["output"]["coverage"]["vectors"]
    );
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    assert!(
        active_rules,
        "B prompt is missing the remembered fact in Active Rules"
    );
    assert_eq!(recall["state"], "delivered", "{output}");
    assert_eq!(result["ok"], true, "{output}");
    assert!(
        output.contains(&code),
        "recall did not return the fact: {output}"
    );
    assert!(before.is_some(), "startup did not create a generation");
    assert_eq!(
        before,
        std::fs::read(descriptor).ok(),
        "restart changed generation"
    );
    assert!(
        !s.provider()?.memory_requests().is_empty(),
        "fresh generation did not enable background extraction"
    );
    s.finish().await
}

/// MEM-03: recall expansion/scope guidance reaches the calling model.
#[tokio::test]
async fn mem_03_recall_optional_arguments_require_user_intent() -> Result<(), HarnessError> {
    use butler_e2e::e2e::cassette::Cassette;
    butler_e2e::gate!();
    let code = nonce();
    let mut cassette = Cassette::load("MEM-01")?;
    let message = cassette.exchanges[0]
        .request
        .key
        .user_request
        .replace("{{NONCE}}", &code);
    memory_stubs::extraction(&mut cassette, "")?;
    let s = Setup::new("MEM-03")?
        .stub_cassette(cassette)
        .placeholder("NONCE", &code)
        .start()
        .await?;
    let (_, turn) = s.turn("general", &message).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let requests = s.provider()?.requests();
    let recall = requests
        .iter()
        .filter_map(|request| request["tools"].as_array())
        .flatten()
        .find(|tool| tool["name"] == "recall_memory")
        .expect("recall tool must be exposed to the calling model");
    let properties = &recall["parameters"]["properties"];
    let seeds = properties["seed_phrases"]["description"].as_str().unwrap();
    assert!(seeds.contains("explicitly supplies") && seeds.contains("do not infer"));
    let scope = properties["scope"]["description"].as_str().unwrap();
    assert!(scope.contains("explicitly asks") && scope.contains("caller's"));
    assert_eq!(recall["parameters"]["required"], serde_json::json!(["cue"]));
    s.finish().await
}

// Synthetic local stub response; no recording or live provider call.
fn memory_response(item: &Value) -> butler_e2e::e2e::cassette::ResponseRecord {
    use butler_e2e::e2e::cassette::{Chunk, ResponseRecord};
    use serde_json::json;
    let events = [
        json!({"type":"response.created","response":{"id":"resp_recall","status":"in_progress","output":[]}}),
        json!({"type":"response.output_item.added","output_index":0,"item":item}),
        json!({"type":"response.function_call_arguments.delta","item_id":item["id"],"output_index":0,"delta":item["arguments"]}),
        json!({"type":"response.function_call_arguments.done","item_id":item["id"],"output_index":0,"arguments":item["arguments"]}),
        json!({"type":"response.output_item.done","output_index":0,"item":item}),
        json!({"type":"response.completed","response":{"id":"resp_recall","object":"response","status":"completed",
            "model":"gpt-6-luna","output":[item],"usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120}}}),
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

/// Fresh generation publication is owned by memory maintenance, not readiness.
#[tokio::test]
async fn mem_03_bootstrap_does_not_hold_service_readiness() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("MEM-03")?
        .env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1")
        .start()
        .await?;
    let descriptor = s
        .sandbox
        .data
        .join("cognition/memory/active-generation.json");
    assert!(!descriptor.exists(), "bootstrap ran despite hold");
    assert!(s.gw.healthy().await, "bootstrap blocked readiness");
    let intent_path = descriptor.with_file_name("fresh-initialization.json");
    let intent: Value = serde_json::from_slice(&std::fs::read(&intent_path)?)?;
    let generation = descriptor
        .parent()
        .unwrap()
        .join("generations")
        .join(intent["generation_id"].as_str().unwrap());
    // Simulate interruption after the reserved generation directory is made.
    std::fs::create_dir_all(&generation)?;
    std::fs::write(generation.join("retained.txt"), b"retained")?;
    // Windows App shutdown can terminate the first Agent after readiness but
    // before publication. The next launch must retain the fresh reservation.
    s.crash_and_restart().await?;
    assert!(
        !descriptor.exists(),
        "bootstrap ran despite hold after restart"
    );
    std::fs::write(
        s.sandbox.data.join("state/e2e-memory-bootstrap-release"),
        b"",
    )?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    while !descriptor.exists() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "fresh generation missing"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let active: Value = serde_json::from_slice(&std::fs::read(&descriptor)?)?;
    assert!(active["generation_id"].is_string(), "{active}");
    assert_eq!(active["generation_id"], intent["generation_id"]);
    assert_eq!(std::fs::read(generation.join("retained.txt"))?, b"retained");
    assert!(generation.join("graph.sqlite").exists());
    assert!(
        !intent_path.exists(),
        "published reservation was not retired"
    );
    s.finish().await
}

/// Existing partial memory and typed sources retain the rebuild path untouched.
#[tokio::test]
async fn mem_04_bootstrap_preserves_nonfresh_memory() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for relative in [
        "cognition/memory/partial",
        "tasks/previous/report.txt",
        "cognition/box/previous.md",
    ] {
        let setup = Setup::new("MEM-04")?;
        let source = setup.sandbox.data.join(relative);
        std::fs::create_dir_all(source.parent().unwrap())?;
        std::fs::write(&source, b"existing source")?;
        let mut s = setup.start().await?;
        s.restart().await?;
        assert_eq!(std::fs::read(&source)?, b"existing source");
        assert!(
            !s.sandbox
                .data
                .join("cognition/memory/active-generation.json")
                .exists()
        );
        assert!(
            !s.sandbox
                .data
                .join("cognition/consolidation/locks/consolidation.lock.coord.sqlite")
                .exists()
        );
        s.finish().await?;
    }
    Ok(())
}

#[path = "memory/batch.rs"]
mod batch;

#[path = "memory/compact.rs"]
mod compact;
