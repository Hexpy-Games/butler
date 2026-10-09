//! Fresh unembedded multilingual memory through chat, restart and the App reset route.
use super::{memory_response, memory_stubs};
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    fixtures,
    scenario::{Fixture, Scenario, Setup},
};
use rusqlite::OpenFlags;
use serde_json::{Value, json};
use std::path::Path;

const ASK: &str = "Recall my lock word.";

fn count(path: &Path, sql: &str) -> i64 {
    butler_platform::sqlite::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .unwrap()
        .query_row(sql, [], |r| r.get(0))
        .unwrap()
}

async fn settled(s: &Scenario, turns: u64) -> Result<std::path::PathBuf, HarnessError> {
    memory_stubs::text_complete(&s.sandbox.data, turns).await?;
    let graph = memory_stubs::graph_path(&s.sandbox.data)?;
    tokio::time::timeout(std::time::Duration::from_secs(90),async {
        loop {
            let db = butler_platform::sqlite::open_with_flags(&graph,OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
            let ready = db.query_row("SELECT NOT EXISTS(SELECT 1 FROM memory_episode_fts_pending) AND NOT EXISTS(SELECT 1 FROM memory_state WHERE key='episode_fts_script_cursor') AND EXISTS(SELECT 1 FROM memory_episode_fts_meta WHERE session_id IS NOT NULL)",[],|r| r.get::<_,bool>(0)).unwrap_or(false);
            if ready { break; }
            tokio::task::yield_now().await;
        }
    }).await.expect("FTS projection did not settle");
    Ok(graph)
}

async fn recall(s: &Scenario) -> Result<Value, HarnessError> {
    let chat =
        s.gw.post(
            "/sessions",
            json!({"kind":"chat","title":"Unembedded recall B"}),
        )
        .await?;
    let id = chat.data()["session"]["id"].as_str().unwrap();
    let start = s.provider()?.requests().len();
    let started = std::time::Instant::now();
    let (_, turn) = s.turn(id, ASK).await?;
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
    let payload = serde_json::from_str(output)?;
    eprintln!(
        "MEM-FTS recall_turn_ms={:.3}",
        started.elapsed().as_secs_f64() * 1000.0
    );
    Ok(payload)
}

async fn start(word: &str, cue: &str) -> Result<(Scenario, String), HarnessError> {
    let mut cassette = Cassette::load("MEM-01")?;
    let remember = cassette.exchanges[0].request.key.user_request.clone();
    // Chat learning is the reset subject; do not create a durable explicit record.
    cassette.exchanges[0].response = cassette.exchanges[1].response.clone();
    let mut call = cassette.exchanges[0].clone();
    call.request.key.user_request = ASK.into();
    call.response = memory_response(
        &json!({"type":"function_call","id":"fc_fts","call_id":"call_fts","name":"recall_memory","status":"completed","arguments":json!({"cue":cue,"include_vector":false,"session_ids":["{{SOURCE_SESSION}}"]}).to_string()}),
    );
    let mut answer = cassette.exchanges[1].clone();
    answer.request.key.user_request = ASK.into();
    cassette.exchanges.extend([call, answer]);
    memory_stubs::extraction(&mut cassette, ASK)?;
    let mut semantic = cassette.exchanges.last().unwrap().clone();
    semantic.request.key.user_request = json!({"speaker":"user","observed_at":"{{TIME}}","parts":[{"id":0,"text":ASK}],"context":[]}).to_string();
    cassette.exchanges.push(semantic);
    for exchange in &mut cassette.exchanges {
        exchange.request.key.user_request = exchange.request.key.user_request.replace(
            "Saved your bike lock code to explicit memory for future conversations.",
            "I will remember that.",
        );
        for chunk in &mut exchange.response.chunks {
            chunk.text = chunk.text.replace(
                "Saved your bike lock code to explicit memory for future conversations.",
                "I will remember that.",
            );
        }
    }
    let setup = Setup::new("MEM-FTS")?
        .fixture(Fixture::Empty)
        .stub_cassette(cassette)
        .placeholder("NONCE", word)
        .env("BUTLER_E2E_APP_NOW", "2026-10-02T04:01:00.000Z")
        .env(
            "BUTLER_E2E_EMBED_MANIFEST",
            "http://127.0.0.1:1/unavailable",
        );
    fixtures::onboarding_complete(&setup.sandbox.data)?;
    fixtures::scheduler_ran_today(&setup.sandbox.data, "2026-10-02T04:01:00.000Z")?;
    Ok((setup.start().await?, remember))
}

async fn scenario(word: &str, cue: &str) -> Result<(), HarnessError> {
    let (mut s, remember) = start(word, cue).await?;
    s.select_model(&s.model).await?;
    assert_eq!(
        s.gw.patch("/settings", json!({"access_mode":"full_access"}))
            .await?
            .status,
        200
    );
    let (_, turn) = s
        .turn("general", &remember.replace("{{NONCE}}", word))
        .await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let graph = settled(&s, 1).await?;
    let db =
        butler_platform::sqlite::open_with_flags(&graph, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let session:String=db.query_row("SELECT conversation_session_id FROM memory_chunks WHERE source_key LIKE 'conversation_turn:%' LIMIT 1",[],|r| r.get(0)).unwrap();
    assert!(
        count(
            &graph,
            "SELECT COUNT(*) FROM memory_episode_fts_meta WHERE session_id IS NOT NULL"
        ) > 0
    );
    drop(db);
    s.provider()?
        .add_placeholder("SOURCE_SESSION", session.clone());
    let before = recall(&s).await?;
    settled(&s, 2).await?;
    assert_eq!(before["ok"], true, "{before}");
    assert_eq!(
        before["output"]["coverage"]["vectors"]["state"], "disabled_by_request",
        "{before}"
    );
    assert!(
        before["output"]["results"].to_string().contains(word),
        "{before}"
    );
    assert_eq!(
        count(
            &graph,
            "SELECT COUNT(*) FROM memory_vector_units WHERE state='complete'"
        ),
        0
    );
    // Emulate the prior analyzer's installed projection, then upgrade on the
    // existing consumer path. Startup remains independent of this optional work.
    s.agent.terminate().await?;
    let db = butler_platform::sqlite::open(&graph).unwrap();
    db.execute("UPDATE memory_episode_fts_v1 SET summary='legacyneutral',entities='legacyneutral',claims='legacyneutral',source='legacyneutral'", []).unwrap();
    db.execute(
        "DELETE FROM memory_state WHERE key='episode_fts_script_seeded'",
        [],
    )
    .unwrap();
    drop(db);
    s.gw = s.agent.start_again().await?;
    settled(&s, 2).await?;
    assert_eq!(
        count(
            &graph,
            "SELECT COUNT(*) FROM memory_episode_fts_v1 WHERE source='legacyneutral'"
        ),
        0
    );
    let after = recall(&s).await?;
    assert!(
        after["output"]["results"].to_string().contains(word),
        "{after}"
    );
    if let Some(workers) =
        butler_platform::process_control::usage::embedding_children(s.agent.pid().unwrap())?
    {
        assert!(workers.is_empty(), "FTS recall loaded an embedding worker");
    }
    settled(&s, 3).await?;
    reset_chat(&s).await?;
    let cleared = recall(&s).await?;
    assert_eq!(cleared["ok"], true, "{cleared}");
    assert!(
        !cleared["output"]["results"].to_string().contains(word),
        "{cleared}"
    );
    eprintln!("MEM-FTS fresh/restart/reset=pass complete_vectors=0 embedding_workers=0");
    s.finish().await
}

async fn reset_chat(s: &Scenario) -> Result<(), HarnessError> {
    let inventory =
        s.gw.post("/memory/inventory/check", json!({}))
            .await?
            .data()
            .clone();
    let operation = uuid::Uuid::new_v4().to_string();
    let accepted =
        s.gw.post(
            "/memory/reset/chat-memory",
            json!({"operation_id":operation,"inventory_revision":inventory["revision"]}),
        )
        .await?;
    assert_eq!(accepted.status, 202, "{}", accepted.text);
    tokio::time::timeout(std::time::Duration::from_secs(90), async {
        loop {
            let receipt = s.gw.get(&format!("/memory/reset/{operation}")).await?;
            assert_ne!(receipt.data()["phase"], "failed", "{}", receipt.text);
            if receipt.data()["phase"] == "complete" {
                return Ok::<_, HarnessError>(());
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("chat reset did not complete")?;
    let reset = memory_stubs::graph_path(&s.sandbox.data)?;
    assert_eq!(
        count(
            &reset,
            "SELECT COUNT(*) FROM memory_episode_fts_v1 WHERE rowid NOT IN (SELECT id FROM memory_episode_fts_meta)"
        ),
        0,
        "reset left orphan FTS postings"
    );
    assert_eq!(
        count(
            &reset,
            "SELECT COUNT(*) FROM memory_episode_fts_meta WHERE session_id IS NOT NULL"
        ),
        0
    );
    Ok(())
}

#[tokio::test]
async fn mem_fts_korean() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    scenario("청자비밀번호", "청자").await
}

#[tokio::test]
async fn mem_fts_english() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    scenario("Azure Café STRAßE", "CAFÉ strasse").await
}

#[tokio::test]
async fn mem_fts_japanese() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    scenario("自転車の暗証番号", "暗証").await
}

#[tokio::test]
async fn mem_fts_mixed() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    scenario("청자Azure비밀번호", "청자azure").await
}

#[tokio::test]
async fn mem_fts_chinese() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    scenario("自行车密码", "密码").await
}

#[tokio::test]
async fn mem_fts_french_diacritics() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    scenario("vélo forêt ÉLÉPHANT", "velo foret elephant").await
}
