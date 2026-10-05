//! Real local embeddings, triggered by recall and the daily window.
use super::{memory_response, memory_stubs};
use butler_e2e::e2e::cassette::Cassette;
use butler_e2e::e2e::gateway::{tool_rows, turn_state};
use butler_e2e::e2e::scenario::{Scenario, Setup};
use butler_e2e::e2e::{HarnessError, fixtures, nonce};
use butler_platform::process_control::usage;
use serde_json::{Value, json};
use std::time::{Duration, Instant};

const WARM: &str = "What is my bike lock code? Call recall_memory with cue bike lock code.";
const COLD_AGAIN: &str =
    "Remind me of my lock code again. Call recall_memory with cue bike lock code.";
const ASK: &str = "How do I unlock my bicycle security cable? Call recall_memory with cue bicycle security cable combination.";

fn setup(name: &str) -> Result<(Setup, String, String), HarnessError> {
    let code = nonce();
    let mut cassette = Cassette::load("MEM-01")?;
    let remember = cassette.exchanges[0].request.key.user_request.clone();
    for (ask, cue) in [
        (WARM, "bike lock code"),
        (COLD_AGAIN, "bike lock code"),
        (ASK, "bicycle security cable combination"),
    ] {
        let mut call = cassette.exchanges[0].clone();
        call.request.key.user_request = ask.into();
        call.response = memory_response(&json!({"type":"function_call","id":"fc_recall",
            "call_id":"call_recall","name":"recall_memory","status":"completed",
            "arguments":json!({"cue":cue}).to_string()}));
        let mut answer = cassette.exchanges[1].clone();
        answer.request.key.user_request = ask.into();
        cassette.exchanges.extend([call, answer]);
    }
    memory_stubs::ordinary(&mut cassette);
    memory_stubs::extraction(&mut cassette, ASK)?;
    let setup = Setup::new(name)?;
    if name == "MEM-DAILY-BATCH" {
        memory_stubs::daily_briefing(&mut cassette, &setup.sandbox.data)?;
    }
    let setup = setup.stub_cassette(cassette).placeholder("NONCE", &code);
    assert!(
        fixtures::embedding_assets(&setup.sandbox.data)?,
        "local embedding assets required"
    );
    Ok((setup, remember.replace("{{NONCE}}", &code), code))
}

async fn ordinary(s: &Scenario, remember: &str) -> Result<u64, HarnessError> {
    for message in [
        remember,
        memory_stubs::ORDINARY_MESSAGES[0],
        memory_stubs::ORDINARY_MESSAGES[1],
    ] {
        let (_, turn) = s.turn("general", message).await?;
        assert_eq!(
            turn_state(&turn),
            "delivered",
            "{turn}; misses={:?}",
            s.provider()?.misses()
        );
    }
    memory_stubs::text_complete(&s.sandbox.data, 3).await?;
    let (pending, complete) = memory_stubs::unit_states(&s.sandbox.data)?;
    assert!(pending > 0);
    assert_eq!(complete, 0);
    if let Some(workers) = usage::embedding_children(s.agent.pid().unwrap())? {
        assert!(workers.is_empty(), "ordinary turns loaded a worker");
    }
    eprintln!("EMBED-AFTER ordinary_turns=3 workers=0 pending={pending} complete={complete}");
    Ok(pending)
}

pub(super) async fn recall(s: &Scenario, chat: &str, ask: &str) -> Result<Value, HarnessError> {
    let first = s.provider()?.requests().len();
    let (id, turn) = s.turn(chat, ask).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let rows = tool_rows(&s.gw.messages(chat).await?, &id);
    let row = rows
        .iter()
        .find(|row| row.to_string().contains("recall_memory"))
        .unwrap();
    assert_eq!(row["state"], "delivered");
    let requests = s.provider()?.requests();
    let output = requests[first..]
        .iter()
        .filter_map(|request| request["input"].as_array())
        .flatten()
        .find(|item| item["type"] == "function_call_output")
        .unwrap()["output"]
        .as_str()
        .unwrap();
    let result: Value = serde_json::from_str(output)?;
    assert_eq!(result["ok"], true, "{output}");
    Ok(result)
}

fn loaded(s: &Scenario) -> Result<(), HarnessError> {
    if let Some(workers) = usage::embedding_children(s.agent.pid().unwrap())? {
        assert_eq!(workers.len(), 1);
        if let Some(memory) = usage::sample(workers[0])? {
            eprintln!("EMBED-LOADED workers=1 rss_bytes={}", memory.resident_bytes);
        }
    }
    let logs = s.agent.logs();
    let load_ms = logs.lines().find_map(|line| {
        line.split_once("load_ms=")?
            .1
            .split_whitespace()
            .next()?
            .parse::<u64>()
            .ok()
    });
    eprintln!(
        "EMBED-LOAD load_ms={}",
        load_ms.expect("initialized worker load measurement")
    );
    assert_eq!(
        logs.matches("[embedding-worker] ready").count(),
        1,
        "model loaded more than once"
    );
    Ok(())
}

#[tokio::test]
async fn mem_05_vector_batch_finds_chat_a_fact_by_paraphrase_in_chat_b() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (setup, remember, code) = setup("MEM-05")?;
    let s = setup.start().await?;
    let pending = ordinary(&s, &remember).await?;
    let began = Instant::now();
    let first = recall(&s, "general", WARM).await?;
    eprintln!(
        "EMBED-COLD first_recall_turn_ms={} coverage={}",
        began.elapsed().as_millis(),
        first["output"]["coverage"]["vectors"]
    );
    assert!(
        first.to_string().contains(&code),
        "text recall missed the pending fact: {first}"
    );
    assert_eq!(
        first["output"]["coverage"]["vectors"]["state"],
        "unavailable"
    );
    memory_stubs::vectors_complete(&s.sandbox.data, 4).await?;
    loaded(&s)?;
    let (remaining, complete) = memory_stubs::unit_states(&s.sandbox.data)?;
    assert_eq!(remaining, 0);
    assert!(complete >= pending);
    let chat =
        s.gw.post("/sessions", json!({"kind":"chat","title":"Memory B"}))
            .await?;
    assert_eq!(chat.status, 201);
    let result = recall(&s, chat.data()["session"]["id"].as_str().unwrap(), ASK).await?;
    assert!(
        result["output"]["results"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item.to_string().contains(&code)
                && item["channels"]
                    .as_array()
                    .is_some_and(|channels| channels.iter().any(|value| value == "vector"))),
        "paraphrase missed the vector fact: {result}"
    );
    memory_stubs::vectors_complete(&s.sandbox.data, 5).await?;
    let drained = Instant::now();
    if usage::embedding_children(s.agent.pid().unwrap())?.is_some() {
        tokio::time::timeout(Duration::from_secs(90), async {
            while !usage::embedding_children(s.agent.pid().unwrap())
                .unwrap()
                .unwrap()
                .is_empty()
            {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        })
        .await
        .expect("idle worker must exit");
    }
    eprintln!(
        "EMBED-DRAIN pending=0 complete={} worker_exit_after_drain_ms={}",
        memory_stubs::unit_states(&s.sandbox.data)?.1,
        drained.elapsed().as_millis()
    );
    // Once reaped, an ordinary turn with a pinned identity still must not reload it.
    let (_, turn) = s
        .turn("general", "I will read a book this evening.")
        .await?;
    assert_eq!(turn_state(&turn), "delivered");
    memory_stubs::text_complete(&s.sandbox.data, 6).await?;
    if let Some(workers) = usage::embedding_children(s.agent.pid().unwrap())? {
        assert!(workers.is_empty());
    }
    assert!(memory_stubs::unit_states(&s.sandbox.data)?.0 > 0);
    let first_after_idle = recall(&s, "general", COLD_AGAIN).await?;
    assert!(first_after_idle.to_string().contains(&code));
    memory_stubs::vectors_complete(&s.sandbox.data, 7).await?;
    assert_eq!(
        s.agent.logs().matches("[embedding-worker] ready").count(),
        2
    );
    assert_eq!(memory_stubs::unit_states(&s.sandbox.data)?.0, 0);
    s.finish().await
}

#[tokio::test]
async fn mem_daily_window_drains_vectors_with_one_load() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (setup, remember, _) = setup("MEM-DAILY-BATCH")?;
    let mut s = setup.start().await?;
    let pending = ordinary(&s, &remember).await?;
    s.agent
        .launch
        .set_env("BUTLER_E2E_APP_NOW", "2026-09-28T04:00:00Z");
    s.restart().await?;
    memory_stubs::vectors_complete(&s.sandbox.data, 3).await?;
    loaded(&s)?;
    let (remaining, complete) = memory_stubs::unit_states(&s.sandbox.data)?;
    assert_eq!(remaining, 0);
    assert_eq!(complete, pending);
    eprintln!(
        "EMBED-DAILY pending_before={pending} pending_after={remaining} complete={complete} loads=1"
    );
    memory_stubs::assert_daily_briefing(&s).await?;
    s.finish().await
}

#[tokio::test]
async fn mem_max_age_drains_on_new_text_work() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (setup, remember, _) = setup("MEM-AGE-BATCH")?;
    let s = setup.start().await?;
    let pending = ordinary(&s, &remember).await?;
    let graph = memory_stubs::graph_path(&s.sandbox.data)?;
    let db = rusqlite::Connection::open(graph).unwrap();
    db.execute("UPDATE memory_projection_jobs SET created_at='2000-01-01T00:00:00Z' WHERE job_id IN (SELECT job_id FROM memory_vector_units WHERE state='pending')", []).unwrap();
    drop(db);
    // Age is checked on new text work, never by an idle timer.
    let (_, turn) = s
        .turn("general", "I will read a book this evening.")
        .await?;
    assert_eq!(turn_state(&turn), "delivered");
    memory_stubs::vectors_complete(&s.sandbox.data, 4).await?;
    loaded(&s)?;
    let (remaining, complete) = memory_stubs::unit_states(&s.sandbox.data)?;
    assert_eq!(remaining, 0);
    assert!(complete >= pending);
    eprintln!("EMBED-AGE pending_before={pending} pending_after=0 complete={complete} loads=1");
    s.finish().await
}
