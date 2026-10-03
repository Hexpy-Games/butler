//! Frozen judge gate and fallback through the public chat/settings surfaces.
use super::{memory_response, memory_stubs};
use butler_e2e::e2e::{
    HarnessError,
    cassette::{Cassette, ResponseRecord},
    scenario::{Scenario, Setup},
};
use serde_json::{Value, json};

const EXACT: &str = "Recall my bike lock code with the exact saved source.";
const ASK: &str = "Recall that activity from September.";
fn recall_args() -> Value {
    json!({"cue":"that activity","include_vector":false,"session_ids":["{{SEED_SESSION}}"],"time":{"from":"2020-01-01T00:00:00Z","to":"2030-01-01T00:00:00Z","basis":"conversation"}})
}
fn judge_reply(request: &Value) -> Option<ResponseRecord> {
    if !request.to_string().contains("recall_ranking") {
        return None;
    }
    Some(memory_response(
        &json!({"type":"message","id":"msg_judge","role":"assistant","status":"completed",
        "content":[{"type":"output_text","text":"{\"ranked\":[2]}","annotations":[]}]}),
    ))
}
async fn setup() -> Result<Scenario, HarnessError> {
    let mut cassette = Cassette::load("MEM-01")?;
    let remember = cassette.exchanges[0].request.key.user_request.clone();
    let mut call = cassette.exchanges[0].clone();
    call.request.key.user_request = ASK.into();
    call.response = memory_response(
        &json!({"type":"function_call","id":"fc_judge_recall","call_id":"call_judge_recall","name":"recall_memory","status":"completed","arguments":recall_args().to_string()}),
    );
    let mut done = cassette.exchanges[1].clone();
    done.request.key.user_request = ASK.into();
    cassette.exchanges.extend([call.clone(), done.clone()]);
    call.request.key.user_request = EXACT.into();
    let mut args = recall_args();
    args["cue"] = "Please save this as a durable explicit memory".into();
    call.response = memory_response(
        &json!({"type":"function_call","id":"fc_exact","call_id":"call_exact","name":"recall_memory","status":"completed","arguments":args.to_string()}),
    );
    done.request.key.user_request = EXACT.into();
    cassette.exchanges.extend([call, done]);
    memory_stubs::extraction(&mut cassette, "")?;
    let setup = Setup::new("MEM-JUDGE")?
        .stub_cassette(cassette)
        .placeholder("NONCE", "synthetic-lock");
    butler_e2e::e2e::fixtures::embedding_assets(&setup.sandbox.data)?;
    let s = setup.start().await?;
    s.provider()?.set_chat_responder(judge_reply);
    let (_, turn) = s
        .turn("general", &remember.replace("{{NONCE}}", "synthetic-lock"))
        .await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    memory_stubs::text_complete(&s.sandbox.data, 1).await?;
    let graph = memory_stubs::graph_path(&s.sandbox.data)?;
    let db = butler_platform::sqlite::open(&graph).unwrap();
    db.execute(
        "UPDATE memory_chunks SET summary=?1,summary_status='complete'",
        ["Synthetic September activity 🙂".repeat(30)],
    )
    .unwrap();
    db.execute(
        "UPDATE memory_state SET value=CAST(value AS INTEGER)+1 WHERE key='graph_revision'",
        [],
    )
    .unwrap();
    let session: String = db.query_row("SELECT conversation_session_id FROM memory_chunks WHERE conversation_session_id IS NOT NULL LIMIT 1", [], |row| row.get(0)).unwrap();
    s.provider()?.add_placeholder("SEED_SESSION", session);
    drop(db);
    Ok(s)
}
async fn recall(s: &Scenario, mode: &str) -> Result<Vec<Value>, HarnessError> {
    recall_question(s, mode, ASK).await
}
async fn recall_question(
    s: &Scenario,
    mode: &str,
    question: &str,
) -> Result<Vec<Value>, HarnessError> {
    let response = s.gw.patch("/settings", json!({"recall_mode":mode})).await?;
    assert_eq!(response.status, 200, "{}", response.text);
    let start = s.provider()?.requests().len();
    let chat =
        s.gw.post("/sessions", json!({"kind":"chat","title":"Recall fixture"}))
            .await?;
    assert_eq!(chat.status, 201, "{}", chat.text);
    let chat = chat.data()["session"]["id"].as_str().unwrap().to_owned();
    let (_, turn) = s.turn(&chat, question).await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let requests = s.provider()?.requests();
    let output = requests[start..]
        .iter()
        .filter_map(|r| r["input"].as_array())
        .flatten()
        .find(|item| item["type"] == "function_call_output")
        .unwrap()["output"]
        .as_str()
        .unwrap();
    let output: Value = serde_json::from_str(output)?;
    Ok(output["output"]["results"].as_array().unwrap().clone())
}
fn judge_count(s: &Scenario) -> usize {
    s.provider
        .as_ref()
        .unwrap()
        .requests()
        .iter()
        .filter(|r| r.to_string().contains("recall_ranking"))
        .count()
}
#[tokio::test]
async fn mem_judge_gated_recall_reorders_and_faster_keeps_base() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = setup().await?;
    let baseline = recall(&s, "faster").await?;
    assert!(baseline.len() >= 2);
    assert_eq!(judge_count(&s), 0);
    let judged = recall(&s, "accurate").await?;
    assert_eq!(judge_count(&s), 1);
    assert_eq!(judged.len(), baseline.len());
    if let Some(workers) =
        butler_platform::process_control::usage::embedding_children(s.agent.pid().unwrap())?
    {
        assert!(
            workers.is_empty(),
            "Summary-only judge loaded an embedding worker"
        );
    }
    assert_eq!(judged[0]["episode_ref"], baseline[1]["episode_ref"]);
    let ids = |rows: &[Value]| {
        let mut ids = rows
            .iter()
            .map(|r| r["episode_ref"].to_string())
            .collect::<Vec<_>>();
        ids.sort();
        ids
    };
    assert_eq!(ids(&judged), ids(&baseline));
    let request = s
        .provider()?
        .requests()
        .into_iter()
        .find(|r| r.to_string().contains("recall_ranking"))
        .unwrap();
    let prompt = request["input"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["role"] == "user")
        .flat_map(|item| item["content"].as_array().into_iter().flatten())
        .find_map(|part| part["text"].as_str())
        .expect("Summary-only user prompt");
    let prompt: Value = serde_json::from_str(prompt)?;
    assert_eq!(prompt["question"], ASK);
    for candidate in prompt["candidates"].as_array().unwrap() {
        assert_eq!(candidate.as_object().unwrap().len(), 2);
        assert!(candidate["summary"].as_str().unwrap().chars().count() <= 150);
    }
    s.restart().await?;
    assert_eq!(s.gw.settings().await?["recall_mode"], "accurate");
    let base_again = recall(&s, "faster").await?;
    assert_eq!(ids(&base_again), ids(&baseline));
    s.finish().await
}

fn unavailable_reply(request: &Value) -> Option<ResponseRecord> {
    judge_reply(request).map(|mut reply| {
        reply.status = 503;
        reply.chunks.clear();
        reply
    })
}
fn episode_ids(rows: &[Value]) -> Vec<Value> {
    rows.iter().map(|r| r["episode_ref"].clone()).collect()
}
#[tokio::test]
async fn mem_judge_provider_failure_and_deadline_preserve_order() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = setup().await?;
    let baseline = recall(&s, "faster").await?;
    s.provider()?.set_chat_responder(unavailable_reply);
    let failed = recall(&s, "accurate").await?;
    assert_eq!(episode_ids(&failed), episode_ids(&baseline));
    assert_eq!(failed.len(), baseline.len());
    assert_eq!(judge_count(&s), 1, "No failed-call retry");
    s.provider()?.set_chat_responder(judge_reply);
    let held = s.provider()?.hold_next_reply("\"question\"");
    let timed_out = recall(&s, "accurate").await?;
    assert_eq!(episode_ids(&timed_out), episode_ids(&baseline));
    assert_eq!(timed_out.len(), baseline.len());
    assert_eq!(judge_count(&s), 2);
    held.release();
    s.finish().await
}

#[tokio::test]
async fn mem_judge_cancellation_drops_request_and_shutdown_drains() -> Result<(), HarnessError> {
    use butler_e2e::e2e::scenario::accepted_turn_id;
    use std::time::Duration;
    butler_e2e::gate!();
    let s = setup().await?;
    let held = s.provider()?.hold_next_reply("\"question\"");
    let chat =
        s.gw.post(
            "/sessions",
            json!({"kind":"chat","title":"Cancellation fixture"}),
        )
        .await?;
    let chat = chat.data()["session"]["id"].as_str().unwrap().to_owned();
    let turn_id = accepted_turn_id(&s.gw.say(&chat, ASK).await?)?;
    tokio::time::timeout(Duration::from_secs(20), async {
        while judge_count(&s) == 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let cancelled =
        s.gw.post(&format!("/turns/{turn_id}/cancel"), json!({}))
            .await?;
    assert_eq!(cancelled.status, 202, "{}", cancelled.text);
    let turn =
        s.gw.wait_terminal(&chat, &turn_id, Duration::from_secs(10))
            .await?;
    assert_eq!(turn["state"], "cancelled");
    assert_eq!(judge_count(&s), 1);
    held.release();
    s.finish().await
}

#[tokio::test]
async fn mem_judge_non_gated_recall_makes_no_call() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = setup().await?;
    let baseline = recall_question(&s, "faster", EXACT).await?;
    let accurate = recall_question(&s, "accurate", EXACT).await?;
    assert!(!baseline.is_empty());
    assert_eq!(episode_ids(&accurate), episode_ids(&baseline));
    assert_eq!(judge_count(&s), 0);
    s.finish().await
}

#[tokio::test]
async fn mem_judge_shutdown_interrupts_active_and_delivers_queued_followup()
-> Result<(), HarnessError> {
    use butler_e2e::e2e::scenario::accepted_turn_id;
    use std::time::Duration;
    butler_e2e::gate!();
    let mut s = setup().await?;
    let held = s.provider()?.hold_next_reply("\"question\"");
    let chat =
        s.gw.post(
            "/sessions",
            json!({"kind":"chat","title":"Shutdown fixture"}),
        )
        .await?;
    let chat = chat.data()["session"]["id"].as_str().unwrap().to_owned();
    let active = accepted_turn_id(&s.gw.say(&chat, ASK).await?)?;
    tokio::time::timeout(Duration::from_secs(20), async {
        while judge_count(&s) == 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let queued = s.gw.post("/session-queue", json!({"chat_id":chat,"text":EXACT,"client_message_id":uuid::Uuid::new_v4().to_string()})).await?;
    assert_eq!(queued.status, 202, "{}", queued.text);
    s.restart().await?;
    held.release();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let turns = s.gw.turns(&chat).await.unwrap();
            if turns.len() == 2 && turns.iter().any(|turn| turn["state"] == "delivered") {
                assert_eq!(
                    turns
                        .iter()
                        .filter(|turn| turn["state"] == "delivered")
                        .count(),
                    1
                );
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("Queued follow-up must complete after restart");
    let interrupted = s.gw.turn(&chat, &active).await?.unwrap();
    assert_eq!(interrupted["state"], "failed");
    assert_eq!(interrupted["safe_error_code"], "turn_interrupted");
    assert_eq!(interrupted["retryable"], true);
    assert_eq!(judge_count(&s), 1, "Interrupted judge must not resume");
    s.finish().await
}
