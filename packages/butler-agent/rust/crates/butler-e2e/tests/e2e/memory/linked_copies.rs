//! A cue reads every copy linked to the thing it names, at any distance.
use super::{memory_response, memory_stubs};
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    fixtures,
    gateway::turn_state,
    nonce,
    scenario::{Scenario, Setup},
};
use butler_platform::sqlite;
use rusqlite::OptionalExtension;
use serde_json::{Value, json};

const ASK: &str = "What do you remember about my cat? Use recall_memory.";
const CUE: &str = "Mango";

#[tokio::test]
async fn mem_recall_reads_every_linked_copy() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let code = nonce();
    let mut cassette = Cassette::load("MEM-01")?;
    let remember = cassette.exchanges[0].request.key.user_request.clone();
    let mut call = cassette.exchanges[0].clone();
    call.request.key.user_request = ASK.into();
    call.request.key.round.clear();
    call.response = memory_response(&json!({
        "type":"function_call","id":"fc_linked","call_id":"call_linked",
        "name":"recall_memory","status":"completed",
        "arguments":json!({"cue":CUE,"include_vector":false}).to_string()
    }));
    let mut answer = cassette.exchanges[1].clone();
    answer.request.key.user_request = ASK.into();
    answer.request.key.round = vec!["function_call".into(), "function_call_output".into()];
    cassette.exchanges.extend([call, answer]);
    memory_stubs::extraction(&mut cassette, "")?;
    let setup = Setup::new("MEM-LINKED-COPIES")?
        .stub_cassette(cassette)
        .placeholder("NONCE", &code);
    fixtures::embedding_assets(&setup.sandbox.data)?;
    let s: Scenario = setup.start().await?;

    let (turn_id, turn) = s
        .turn("general", &remember.replace("{{NONCE}}", &code))
        .await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    memory_stubs::text_complete(&s.sandbox.data, 1).await?;

    let graph = memory_stubs::graph_path(&s.sandbox.data)?;
    let (conversation, explicit): ((String, String, String), (String, String, String)) =
        tokio::time::timeout(std::time::Duration::from_secs(30), async {
            loop {
                let db = sqlite::open_with_flags(&graph, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                    .unwrap();
                let conversation = db.query_row(
                    "SELECT s.source_id,s.episode_id,s.revision FROM memory_chunk_sources s JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision WHERE c.source_key=?1 AND s.role='user' AND EXISTS(SELECT 1 FROM memory_projection_jobs j WHERE j.episode_id=c.memory_chunk_id AND json_extract(j.semantic_graph_state,'$.state')='complete') ORDER BY s.byte_start LIMIT 1",
                    [format!("conversation_turn:{turn_id}")],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                ).optional().unwrap();
                let explicit = db.query_row(
                    "SELECT s.source_id,s.episode_id,s.revision FROM memory_chunk_sources s JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision WHERE s.source_kind='explicit_record' AND s.role='explicit' AND EXISTS(SELECT 1 FROM memory_projection_jobs j WHERE j.episode_id=c.memory_chunk_id AND json_extract(j.semantic_graph_state,'$.state')='complete') LIMIT 1",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                ).optional().unwrap();
                if let (Some(conversation), Some(explicit)) = (conversation, explicit) {
                    return (conversation, explicit);
                }
                drop(db);
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        }).await.expect("remembered conversation and explicit sources must register");

    {
        let db = sqlite::open(&graph).unwrap();
        db.execute_batch("BEGIN IMMEDIATE").unwrap();
        for (i, name) in (1..=5).zip([CUE, "Goldie", "Sunny", "Pip", "Biscuit"]) {
            let node = format!("copy-{i}");
            let (source, episode, revision) = if i == 5 { &explicit } else { &conversation };
            db.execute(
                "INSERT INTO memory_nodes(id,type,label_original,identity_scope,created_at) VALUES(?1,'entity',?2,'user','2026-10-02T00:00:00.000Z')",
                [node.as_str(), name],
            ).unwrap();
            db.execute(
                "INSERT INTO memory_aliases(node_id,surface_original,nfc_key,folded_key,source_id,resolution_kind) VALUES(?1,?2,?2,?3,?4,'literal')",
                [node.as_str(), name, &name.to_lowercase(), source],
            ).unwrap();
            db.execute(
                "INSERT INTO memory_evidence(node_id,source_id,episode_id,revision) VALUES(?1,?2,?3,?4)",
                [&node, source, episode, revision],
            ).unwrap();
        }
        for (a, b) in (1..=4).zip(2..=5) {
            let edge = format!("link-{a}-{b}");
            db.execute(
                "INSERT INTO edges(edge_id,source_node_id,target_node_id,rel_type,status) VALUES(?1,?2,?3,'identity_match','active')",
                [&edge, &format!("copy-{a}"), &format!("copy-{b}")],
            ).unwrap();
            let evidence = "INSERT INTO edge_evidence(edge_id,chunk_source_id,basis,extraction_version) VALUES(?1,?2,'inference','memory-extract-v3')";
            db.execute(evidence, [&edge, &conversation.0]).unwrap();
            if b == 5 {
                db.execute(evidence, [&edge, &explicit.0]).unwrap();
            }
        }
        db.execute_batch("COMMIT").unwrap();
        db.execute(
            "UPDATE memory_state SET value=CAST(value AS INTEGER)+1 WHERE key='graph_revision'",
            [],
        )
        .unwrap();
    }
    memory_stubs::text_complete(&s.sandbox.data, 1).await?;

    let chat =
        s.gw.post("/sessions", json!({"kind":"chat","title":"Linked copies"}))
            .await?;
    assert_eq!(chat.status, 201, "{}", chat.text);
    let chat = chat.data()["session"]["id"].as_str().unwrap().to_owned();
    let start = s.provider()?.requests().len();
    let (_, turn) = s.turn(&chat, ASK).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");

    let requests = s.provider()?.requests();
    let output = requests[start..]
        .iter()
        .filter_map(|request| request["input"].as_array())
        .flatten()
        .find(|item| item["type"] == "function_call_output")
        .unwrap();
    let result: Value = serde_json::from_str(output["output"].as_str().unwrap())?;
    assert_eq!(result["ok"], true, "{result}");
    let mut evidence = result["output"]["results"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| entry["evidence"].as_array())
        .flatten();
    assert!(
        evidence
            .clone()
            .any(|item| item["source_kind"] == "conversation"),
        "{result}"
    );
    assert!(
        evidence.any(|item| item["source_kind"] == "explicit_record"),
        "{result}"
    );

    s.finish().await
}
