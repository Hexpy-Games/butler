//! MEM-06: compact first page, exact pinned detail, original source, stale rejection.
use super::{memory_response, memory_stubs};
use butler_e2e::e2e::gateway::turn_state;
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    fixtures, nonce,
    scenario::{Scenario, Setup},
};
use butler_platform::sqlite;
use rusqlite::OptionalExtension;
use serde_json::{Value, json};
use std::path::PathBuf;

const ASK: &str =
    "Recall my bike lock code, expand its interpretations, then read the original conversation.";
// Anchor the protocol fixture to the raw user source that owns the seeded claim.
const CUE: &str = "Please save this as a durable explicit memory";
const STALE: &str = "Expand the previous bike lock interpretation handle again.";

fn calls(cassette: &mut Cassette) {
    let template = cassette.exchanges[0].clone();
    let answer = cassette.exchanges[1].clone();
    let operations = [
        ("recall_memory", json!({"cue":CUE,"include_vector":false})),
        (
            "recall_memory",
            json!({"cue":CUE,"detail_handles":["{{DETAIL_ECHO_1}}"]}),
        ),
        ("read_conversation_session", json!("{{RECALL_READ_ARGS}}")),
    ];
    for (i, (name, arguments)) in operations.into_iter().enumerate() {
        let mut exchange = template.clone();
        exchange.request.key.user_request = ASK.into();
        exchange.request.key.round = ["function_call", "function_call_output"]
            .repeat(i)
            .into_iter()
            .map(str::to_owned)
            .collect();
        exchange.response = memory_response(
            &json!({"type":"function_call","id":format!("fc_compact{i}"),
            "call_id":format!("call_compact{i}"),"name":name,"status":"completed","arguments":arguments.as_str().map_or_else(|| arguments.to_string(), str::to_owned)}),
        );
        cassette.exchanges.push(exchange);
    }
    let mut done = answer.clone();
    done.request.key.user_request = ASK.into();
    done.request.key.round = ["function_call", "function_call_output"]
        .repeat(3)
        .into_iter()
        .map(str::to_owned)
        .collect();
    cassette.exchanges.push(done);
    let mut stale = template;
    stale.request.key.user_request = STALE.into();
    stale.response = memory_response(
        &json!({"type":"function_call","id":"fc_stale","call_id":"call_stale",
        "name":"recall_memory","status":"completed","arguments":json!({"cue":CUE,"detail_handles":["{{DETAIL_ECHO_1}}"]}).to_string()}),
    );
    cassette.exchanges.push(stale);
    let mut done = answer;
    done.request.key.user_request = STALE.into();
    cassette.exchanges.push(done);
}

async fn seed_claim(s: &Scenario, turn: &str, code: &str) -> Result<PathBuf, HarnessError> {
    let descriptor: Value = serde_json::from_slice(&std::fs::read(
        s.sandbox
            .data
            .join("cognition/memory/active-generation.json"),
    )?)?;
    let graph = s
        .sandbox
        .data
        .join("cognition/memory/generations")
        .join(descriptor["generation_id"].as_str().unwrap())
        .join("graph.sqlite");
    let (source, episode, revision) = remembered_source(&graph, turn).await;
    let db = sqlite::open(&graph).unwrap();
    // The shared empty semantic stub deliberately supplies no summary or claims.
    db.execute(
        "UPDATE memory_chunks SET summary=?1,summary_status='complete' WHERE memory_chunk_id=?2",
        [
            format!("{CUE}: the bike lock code is {code}."),
            episode.clone(),
        ],
    )
    .unwrap();
    db.execute("INSERT INTO memory_nodes(id,type,label_original,identity_scope,created_at) VALUES('compact-claim','memory_atom','bike lock code','global','2026-10-02T00:00:00.000Z')", []).unwrap();
    db.execute("INSERT INTO memory_claims(node_id,statement,speech_act,basis,polarity,salience,source_class) VALUES('compact-claim',?1,'assertion','user_statement','positive','high','user')", [format!("The bike lock code is {code}.")]).unwrap();
    db.execute("INSERT INTO memory_evidence(node_id,source_id,episode_id,revision) VALUES('compact-claim',?1,?2,?3)", [&source, &episode, &revision]).unwrap();
    db.execute("INSERT INTO memory_mentions(node_id,source_id,surface,method) VALUES('compact-claim',?1,'bike lock code','inferred')", [&source]).unwrap();
    db.execute(
        "UPDATE memory_state SET value=CAST(value AS INTEGER)+1 WHERE key='graph_revision'",
        [],
    )
    .unwrap();
    Ok(graph)
}

// Delivery and explicit-memory vectors can precede conversation registration.
async fn remembered_source(graph: &std::path::Path, turn: &str) -> (String, String, String) {
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            let db = sqlite::open_with_flags(graph, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
            let source = db.query_row(
                "SELECT s.source_id,s.episode_id,s.revision FROM memory_chunk_sources s JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id WHERE c.source_key=?1 AND s.role='user' AND EXISTS(SELECT 1 FROM memory_projection_jobs j WHERE j.episode_id=c.memory_chunk_id AND json_extract(j.semantic_graph_state,'$.state')='complete') ORDER BY s.byte_start LIMIT 1",
                [format!("conversation_turn:{turn}")],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional().unwrap();
            if let Some(source) = source { return source; }
            drop(db);
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }).await.expect("remembered user source must register")
}

fn outputs(s: &Scenario, start: usize) -> Vec<Value> {
    s.provider().unwrap().requests()[start..]
        .iter()
        .filter_map(|request| request["input"].as_array())
        .flatten()
        .filter(|item| item["type"] == "function_call_output")
        .map(|item| serde_json::from_str(item["output"].as_str().unwrap()).unwrap())
        .fold(Vec::new(), |mut values, value| {
            if !values.contains(&value) {
                values.push(value);
            }
            values
        })
}

#[tokio::test]
async fn mem_06_compact_detail_and_source_are_pinned() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let code = nonce();
    let mut cassette = Cassette::load("MEM-01")?;
    let remember = cassette.exchanges[0].request.key.user_request.clone();
    calls(&mut cassette);
    memory_stubs::extraction(&mut cassette, "")?;
    let setup = Setup::new("MEM-06")?
        .stub_cassette(cassette)
        .placeholder("NONCE", &code);
    fixtures::embedding_assets(&setup.sandbox.data)?;
    let s = setup.start().await?;
    let (id, turn) = s
        .turn("general", &remember.replace("{{NONCE}}", &code))
        .await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    memory_stubs::text_complete(&s.sandbox.data, 1).await?;
    let graph = seed_claim(&s, &id, &code).await?;
    memory_stubs::text_complete(&s.sandbox.data, 1).await?;
    let start = s.provider()?.requests().len();
    let (_, turn) = s.turn("general", ASK).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let values = outputs(&s, start);
    assert_eq!(values.len(), 3, "{values:#?}");
    assert_contract(&values, &code);
    let requests = s.provider()?.requests();
    let arguments = requests[start..]
        .iter()
        .filter_map(|request| request["input"].as_array())
        .flatten()
        .find(|item| item["type"] == "function_call" && item["name"] == "read_conversation_session")
        .unwrap()["arguments"]
        .as_str()
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(arguments)?,
        values[0]["output"]["results"][0]["evidence"][0]["read_args"]
    );
    sqlite::open(&graph)
        .unwrap()
        .execute(
            "UPDATE memory_state SET value='compact-stale' WHERE key='graph_revision'",
            [],
        )
        .unwrap();
    let start = s.provider()?.requests().len();
    let (_, turn) = s.turn("general", STALE).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let stale = outputs(&s, start);
    assert!(
        stale[0].to_string().contains("stale_detail_handle"),
        "{stale:?}"
    );
    assert!(
        stale[0].to_string().contains("recall_memory again"),
        "{stale:?}"
    );
    s.finish().await
}

fn assert_contract(values: &[Value], code: &str) {
    assert!(values[0].to_string().len() <= 24 * 1024);
    let first = &values[0]["output"]["results"][0];
    assert!(first.get("interpretations").is_none());
    assert_eq!(first["interpretation_count"], 1);
    assert_eq!(first["current_state_requires_verification"], true);
    assert!(first["qualifications"].is_array());
    assert!(
        first["summary"]
            .as_str()
            .is_some_and(|summary| summary.contains(code))
    );
    let detail = &values[1]["output"]["details"][0];
    assert_eq!(
        detail["interpretation_handle"],
        first["interpretation_handle"]
    );
    assert_eq!(detail["episode_ref"], first["episode_ref"]);
    assert_eq!(detail["first_page_interpretations"], json!([]));
    assert!(
        detail["evidence"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["source_ref"] == first["evidence"][0]["source_ref"])
    );
    assert_eq!(
        detail["interpretations"],
        json!([{
            "node_ref":"compact-claim", "statement":format!("The bike lock code is {code}."),
            "speech_act":"assertion", "basis":"user_statement", "source_class":"user",
            "authority":"model_interpretation", "source_refs":[first["evidence"][0]["source_ref"]],
            "support_complete":true, "status":"recorded"
        }])
    );
    assert_eq!(values[2]["ok"], true, "{}", values[2]);
    assert!(values[2].to_string().contains(code), "{}", values[2]);
}
