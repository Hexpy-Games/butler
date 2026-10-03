//! Real cached embeddings survive reset when supported by an instruction source.
use super::{memory_response, memory_stubs};
use butler_e2e::e2e::{HarnessError, cassette::Cassette, fixtures, nonce, scenario::Setup};
use butler_platform::sqlite;
use rusqlite::OpenFlags;
use serde_json::{Value, json};
use std::{path::Path, time::Duration};
const ASK: &str = "What is my bike lock code? Call recall_memory with cue bike lock code.";
fn typed_vectors(root: &Path) -> Result<i64, HarnessError> {
    let memory = root.join("cognition/memory");
    let descriptor: Value =
        serde_json::from_slice(&std::fs::read(memory.join("active-generation.json"))?)?;
    let graph = memory
        .join("generations")
        .join(descriptor["generation_id"].as_str().unwrap())
        .join("graph.sqlite");
    let db = sqlite::open_with_flags(graph, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    Ok(db.query_row("SELECT COUNT(*) FROM memory_vector_units u JOIN memory_projection_jobs j ON j.job_id=u.job_id JOIN memory_chunk_sources s ON s.episode_id=j.episode_id WHERE u.state='complete' AND s.source_kind='explicit_record'", [], |r| r.get(0)).unwrap())
}
#[tokio::test]
async fn reset_preserves_nonempty_instruction_vectors_and_their_recall() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let code = nonce();
    let mut cassette = Cassette::load("MEM-01")?;
    let remember = cassette.exchanges[0].request.key.user_request.clone();
    let mut call = cassette.exchanges[0].clone();
    call.request.key.user_request = ASK.into();
    call.response = memory_response(
        &json!({"type":"function_call","id":"fc_recall", "call_id":"call_recall","name":"recall_memory","status":"completed", "arguments":json!({"cue":"bike lock code"}).to_string()}),
    );
    let mut answer = cassette.exchanges[1].clone();
    answer.request.key.user_request = ASK.into();
    cassette.exchanges.extend([call, answer]);
    memory_stubs::extraction(&mut cassette, ASK)?;
    let setup = Setup::new("MEM-RESET-VECTORS")?
        .stub_cassette(cassette)
        .placeholder("NONCE", &code);
    assert!(
        fixtures::embedding_assets(&setup.sandbox.data)?,
        "local embedding assets required"
    );
    let s = setup.start().await?;
    assert_eq!(
        s.turn("general", &remember.replace("{{NONCE}}", &code))
            .await?
            .1["state"],
        "delivered"
    );
    memory_stubs::text_complete(&s.sandbox.data, 1).await?;
    let before = super::batch::recall(&s, "general", ASK).await?;
    assert!(before.to_string().contains(&code));
    memory_stubs::vectors_complete(&s.sandbox.data, 1).await?;
    let count = typed_vectors(&s.sandbox.data)?;
    assert!(
        count > 0,
        "reset must exercise a nonempty typed vector projection"
    );
    let checked = s.gw.post("/memory/inventory/check", json!({})).await?;
    assert_eq!(checked.status, 200, "{}", checked.text);
    let id = uuid::Uuid::new_v4().to_string();
    let accepted =
        s.gw.post(
            "/memory/reset/chat-memory",
            json!({"operation_id":id,"inventory_revision":checked.data()["revision"]}),
        )
        .await?;
    assert_eq!(accepted.status, 202, "{}", accepted.text);
    tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            let reply = s.gw.get(&format!("/memory/reset/{id}")).await?;
            assert_ne!(reply.data()["phase"], "failed", "{}", reply.text);
            if reply.data()["phase"] == "complete" && reply.data()["removal_pending"] == false {
                return Ok::<_, HarnessError>(());
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("reset completion")?;
    assert_eq!(typed_vectors(&s.sandbox.data)?, count);
    let after = super::batch::recall(&s, "general", ASK).await?;
    assert_eq!(after["ok"], true);
    assert!(
        after.to_string().contains(&code),
        "typed recall disappeared: {after}"
    );
    assert_eq!(
        after["output"]["coverage"]["vectors"]["state"], "ok",
        "{after}"
    );
    s.finish().await
}
