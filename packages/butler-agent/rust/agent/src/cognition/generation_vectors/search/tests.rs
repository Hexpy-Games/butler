//! Manual source-created Lance fixture check; fixture path is explicitly supplied.

use std::{fs, path::PathBuf};

use serde_json::{Value, json};

use crate::cognition::{CognitionPathEnvironment, RecallRequest, resolve_active_generation};

use super::search_generation_vectors;

#[tokio::test]
#[ignore = "requires the isolated JavaScript 3.8.1 generation fixture"]
async fn source_generation_rows_match_native_query() {
    let data = PathBuf::from(std::env::var("BUTLER_JS_COMPAT_DATA").expect("fixture data path"));
    let oracle: Value = serde_json::from_slice(
        &fs::read(data.join("fixture-source-oracle.json")).expect("source oracle"),
    )
    .expect("valid source oracle");
    let generation = resolve_active_generation(&data, &CognitionPathEnvironment::default())
        .expect("source generation");
    for (query, vector) in oracle["oracles"]
        .as_array()
        .unwrap()
        .iter()
        .zip(oracle["query_vectors"].as_array().unwrap())
    {
        let cue = query["query"].as_str().unwrap();
        let request: RecallRequest = serde_json::from_value(json!({
            "cue": cue, "includeVector":true, "includeInternal":false, "limit":10,
            "scope":"all_user_sessions", "projectFilter":"any", "projectIds":[],
            "sessionIds":[], "asOf":"2026-09-24T00:00:00.000Z",
            "runtime":{"sessionId":"fixture","turnId":"fixture","currentUserMessage":cue,
                "nativeOperationId":"fixture","projectId":null}
        }))
        .unwrap();
        let vector = vector
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_f64().unwrap() as f32)
            .collect();
        let native = search_generation_vectors(&data, &generation, &request, &[vector])
            .await
            .expect("native Lance search");
        for (kind, matches) in [("node", native.nodes), ("episode", native.episodes)] {
            let expected = query["hits"][kind].as_array().unwrap();
            assert_eq!(matches.len(), expected.len(), "{cue} {kind} row count");
            for (row, expected) in matches.iter().zip(expected) {
                assert_eq!(
                    row.vector_key,
                    expected["vector_key"].as_str().unwrap(),
                    "{cue} {kind} key"
                );
                assert_eq!(
                    row.owner_id,
                    expected["owner_id"].as_str().unwrap(),
                    "{cue} {kind} owner"
                );
                assert!(
                    (row.distance - expected["distance"].as_f64().unwrap()).abs() < 1e-4,
                    "{cue} {kind} distance {} != {}",
                    row.distance,
                    expected["distance"]
                );
            }
        }
    }
}
