//! Completed turns refresh Hot Cache without invalidating earlier history bytes.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E assertions")]
use butler_e2e::e2e::fake_servers::{ChatBehavior, FakeServer, LOCAL_MODEL};
use butler_e2e::e2e::{
    HarnessError, fixtures,
    scenario::{Fixture, Setup},
};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{path::Path, time::Duration};

#[tokio::test]
async fn completed_turn_cache_changes_follow_previous_history() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let server = FakeServer::local_models(ChatBehavior {
        answer: json!({"status":"processed","entities":[],"items":[
            {"kind":"preference","subject":null,"text":"I prefer blue iris flowers.","evidence":[0]}
        ],"attributes":[]})
        .to_string(),
        chunk_delay: Duration::ZERO,
        ..ChatBehavior::default()
    })
    .await?;
    let setup = Setup::new("PROMPT-HISTORY-CACHE")?.fixture(Fixture::Empty);
    fixtures::ready(
        &setup.sandbox.data,
        "openai/gpt-6-luna",
        fixtures::FIXTURE_TIME,
    )?;
    let s = setup.start().await?;
    let reply =
        s.gw.post(
            "/model-catalog/local-models",
            json!({
                "provider_id":"local","api_type":"openai_compatible","platform":"ollama",
                "server_url":server.base_url,"model_id":LOCAL_MODEL,"display_name":LOCAL_MODEL,
                "context_window_tokens":131_072,"source":"discovered"
            }),
        )
        .await?;
    assert_eq!(reply.status, 201);
    let model = &reply.data()["model"]["model_ref"];
    let reply =
        s.gw.patch(
            "/settings",
            json!({
                "model":model,"consolidation_model":model,"access_mode":"full_access"
            }),
        )
        .await?;
    assert_eq!(reply.status, 200);
    let mut previous = Vec::new();
    let mut previous_end = 0;
    let mut previous_cache = String::new();
    for index in 0..3 {
        let ask = format!("I prefer blue iris flowers. Cache history turn {index}.");
        let start = server.chat_requests().len();
        let (id, turn) = s.turn("general", &ask).await?;
        assert_eq!(turn["state"], "delivered");
        let requests = server.chat_requests();
        let request = requests[start..]
            .iter()
            .find(|request| source(request).is_some_and(|text| text.ends_with(&ask)))
            .expect("parent source prompt");
        let text = source(request).unwrap();
        let heading = text.find("## Current turn context").unwrap();
        let end = text[..heading].trim_end().len();
        let wire = serde_json::to_vec(request)?;
        let history_prefix = serde_json::to_string(&text[..end])?;
        let encoded = &history_prefix.as_bytes()[..history_prefix.len() - 1];
        let boundary = wire
            .windows(encoded.len())
            .position(|bytes| bytes == encoded)
            .unwrap()
            + encoded.len();
        if !previous.is_empty() {
            let differing = previous
                .iter()
                .zip(&wire)
                .position(|(a, b)| a != b)
                .unwrap_or(previous.len().min(wire.len()));
            assert!(
                differing >= previous_end,
                "diverged at {differing}, history ends at {previous_end}"
            );
            assert!(text[..end].contains("Cache history turn 0"));
        }
        if index > 0 {
            assert!(text.find("## Hot Cache").unwrap() >= heading);
            assert!(text.find("## Active Rules").unwrap() >= heading);
            assert!(text.contains("Use concise answers. Seed rule 1."));
            let db = Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
            let cache: String = db.query_row(
                "SELECT content FROM btcc_context_documents WHERE source_id='hot-cache' ORDER BY rowid DESC LIMIT 1",
                [], |row| row.get(0),
            )?;
            assert!(
                text.contains(&cache),
                "Hot Cache content was changed or dropped"
            );
            if index > 1 {
                assert_ne!(cache, previous_cache, "fixture did not refresh Hot Cache");
            }
            previous_cache = cache;
        }
        previous = wire;
        previous_end = boundary;
        wait_cache(&s.sandbox.data, &id).await?;
        if index == 0 {
            let rules = s.sandbox.data.join("cognition/memory/rules");
            std::fs::create_dir_all(&rules)?;
            std::fs::write(rules.join("global.md"), "Use concise answers. Seed rule 1.")?;
            std::fs::write(rules.join("INDEX.md"), "- [global](global.md)\n")?;
        }
    }
    s.finish().await
}

fn source(request: &Value) -> Option<&str> {
    request["messages"]
        .as_array()?
        .iter()
        .filter_map(|message| message["content"].as_str())
        .find(|text| text.contains("## Conversation history"))
}

async fn wait_cache(data: &Path, turn: &str) -> Result<(), HarnessError> {
    tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            let active = data.join("cognition/memory/active-generation.json");
            if let Ok(bytes) = std::fs::read(&active) {
                let descriptor: Value = serde_json::from_slice(&bytes)?;
                let graph = data.join("cognition/memory/generations")
                    .join(descriptor["generation_id"].as_str().unwrap()).join("graph.sqlite");
                let db = Connection::open(graph)?;
                let count: u64 = db.query_row("SELECT COUNT(*) FROM memory_projection_jobs j JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id WHERE c.source_key=?1 AND json_extract(j.hot_cache_state,'$.state')='complete'", [format!("conversation_turn:{turn}")], |r|r.get(0))?;
                if count > 0 { return Ok::<(), HarnessError>(()); }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }).await.expect("cache did not complete")
}
