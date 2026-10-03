//! Existing serving folders retain historical metadata and inactive artifacts.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::cassette::Cassette;
use butler_e2e::e2e::gateway::{tool_rows, turn_state};
use butler_e2e::e2e::scenario::Setup;
use butler_e2e::e2e::{HarnessError, fixtures, nonce};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::Path;
use super::memory_fixture;
#[allow(
    dead_code,
    reason = "shared memory fixture also supports batch-only scenarios"
)]
#[path = "memory/stubs.rs"]
mod memory_stubs;

#[tokio::test]
async fn existing_generation_metadata_survives_native_writes_and_recall() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    for javascript in [true, false] {
        existing_folder(javascript).await?;
    }
    Ok(())
}

async fn existing_folder(javascript: bool) -> Result<(), HarnessError> {
    let code = nonce();
    let mut cassette = Cassette::load("MEM-01")?;
    let remember = cassette.exchanges[0].request.key.user_request.clone();
    let ask = "How do I unlock my bicycle security cable? Call recall_memory with cue bicycle security cable combination.";
    let warm = "What is my bike lock code? Call recall_memory with cue bike lock code.";
    for (request, cue) in [
        (warm, "bike lock code"),
        (ask, "bicycle security cable combination"),
    ] {
        let mut call = cassette.exchanges[0].clone();
        call.request.key.user_request = request.into();
        call.response = memory_response(&json!({"type":"function_call","id":"fc_recall",
            "call_id":"call_recall","name":"recall_memory","status":"completed",
            "arguments":json!({"cue":cue}).to_string()}));
        let mut answer = cassette.exchanges[1].clone();
        answer.request.key.user_request = request.into();
        cassette.exchanges.extend([call, answer]);
    }
    memory_stubs::extraction(&mut cassette, ask)?;
    let setup = Setup::new("MEM-EXISTING")?
        .stub_cassette(cassette)
        .placeholder("NONCE", &code);
    assert!(fixtures::embedding_assets(&setup.sandbox.data)?);
    let graph = memory_fixture::initialize_empty(&setup.sandbox.data)?;
    let root = graph.parent().unwrap();
    let manifest_path = root.join("manifest.json");
    let expected = historical_manifest(&setup.sandbox.data, &manifest_path, javascript)?;
    let memory = root.parent().unwrap().parent().unwrap();
    let descriptor = std::fs::read(memory.join("active-generation.json"))?;
    let retired = memory.join("generations/11111111-1111-1111-1111-111111111111");
    std::fs::create_dir_all(retired.join("source-snapshot"))?;
    let inactive = [
        ("manifest.json", br#"{"schema":"butler.memory-generation.v2","generation_id":"11111111-1111-1111-1111-111111111111","format":"legacy","state":"retired","embedding":null}"#.as_slice()),
        ("source-snapshot/retained", b"dormant snapshot".as_slice()),
        ("qualification.json", b"dormant qualification".as_slice()),
    ];
    for (path, bytes) in &inactive {
        std::fs::write(retired.join(path), bytes)?;
    }
    let mut s = setup.start().await?;
    s.restart().await?;
    let (_, turn) = s
        .turn("general", &remember.replace("{{NONCE}}", &code))
        .await?;
    assert_eq!(
        turn_state(&turn),
        "delivered",
        "{turn}; misses={:?}",
        s.provider()?.misses()
    );
    memory_stubs::text_complete(&s.sandbox.data, 1).await?;
    // A cold recall admits the pending vector batch; the next recall must still
    // prove vector retrieval against the unchanged historical generation.
    let (_, cold) = s.turn("general", warm).await?;
    assert_eq!(turn_state(&cold), "delivered");
    memory_stubs::vectors_complete(&s.sandbox.data, 2).await?;
    let chat =
        s.gw.post(
            "/sessions",
            json!({"kind":"chat","title":"Existing folder recall"}),
        )
        .await?;
    assert_eq!(chat.status, 201);
    let session = chat.data()["session"]["id"].as_str().unwrap().to_owned();
    let first = s.provider()?.requests().len();
    let (turn_id, turn) = s.turn(&session, ask).await?;
    assert_eq!(
        turn_state(&turn),
        "delivered",
        "{turn}; misses={:?}",
        s.provider()?.misses()
    );
    let rows = tool_rows(&s.gw.messages(&session).await?, &turn_id);
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
    assert_eq!(result["ok"], true);
    assert!(
        result["output"]["results"]
            .as_array()
            .unwrap_or_else(|| panic!("missing recall results: {output}"))
            .iter()
            .any(|item| item.to_string().contains(&code)
                && item["channels"]
                    .as_array()
                    .is_some_and(|lanes| lanes.iter().any(|lane| lane == "vector"))),
        "vector fact missing (javascript={javascript}): {output}"
    );
    let actual: Value = serde_json::from_slice(&std::fs::read(&manifest_path)?)?;
    for (key, value) in expected.as_object().unwrap() {
        if key != "embedding" {
            assert_eq!(&actual[key], value, "changed historical field {key}");
        }
    }
    if javascript {
        assert_eq!(actual["embedding"], expected["embedding"]);
    } else {
        assert_eq!(
            actual["embedding"]["schema"],
            "butler.native-embedding-identity.v1"
        );
    }
    assert_eq!(
        std::fs::read(memory.join("active-generation.json"))?,
        descriptor
    );
    for (path, bytes) in inactive {
        assert_eq!(std::fs::read(retired.join(path))?, bytes);
    }
    s.finish().await
}

fn historical_manifest(data: &Path, path: &Path, javascript: bool) -> Result<Value, HarnessError> {
    let mut value: Value = serde_json::from_slice(&std::fs::read(path)?)?;
    let historical: Value = serde_json::from_str(include_str!(
        "../../../butler-memory/src/cognition/generation/fixtures/format/qualified-manifest.json"
    ))?;
    for key in [
        "canonical_snapshot_id",
        "canonical_snapshot_path",
        "canonical_snapshot",
        "source_inventory_hash",
        "readiness",
        "required_acceptance_passed",
        "acceptance_binding",
    ] {
        value[key] = historical[key].clone();
    }
    value["owner_extra"] = json!({"keep":[true,null,{"nested":"opaque"}]});
    if javascript {
        let assets = data.join("cache/models/Xenova/bge-m3");
        let tokenizer = asset_identity(&assets, &["tokenizer.json", "tokenizer_config.json"])?;
        let model = asset_identity(&assets, &["config.json", "onnx/model_quantized.onnx"])?;
        let identity = json!([
            "butler-embedding-runtime-v1",
            "Xenova/bge-m3",
            "3.8.1",
            "cls",
            true,
            1024,
            8192,
            tokenizer,
            model,
            "v22.0.0",
            null
        ]);
        value["embedding"] = json!({"model":"Xenova/bge-m3","dimension":1024,"pooling":"cls","normalize":true,
            "max_tokens":8192,"transformers_version":"3.8.1","node_runtime_version":"v22.0.0","bun_runtime_version":null,
            "tokenizer_asset_sha256":tokenizer,"model_asset_sha256":model,"version":format!("{:x}",Sha256::digest(identity.to_string().as_bytes()))});
        // The descriptor remains authoritative when historical manifest state lags it.
        value["state"] = json!("ready");
        value["initialization_origin"] = json!("rebuild");
    }
    std::fs::write(path, serde_json::to_vec(&value)?)?;
    Ok(value)
}

fn asset_identity(root: &Path, files: &[&str]) -> Result<String, HarnessError> {
    let mut aggregate = Sha256::new();
    for relative in files {
        let digest = format!("{:x}", Sha256::digest(std::fs::read(root.join(relative))?));
        aggregate.update(serde_json::to_vec(&(relative, digest))?);
    }
    Ok(format!("{:x}", aggregate.finalize()))
}

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
