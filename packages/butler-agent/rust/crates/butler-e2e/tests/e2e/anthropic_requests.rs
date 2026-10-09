//! Anthropic wire compatibility through the product gateway and a strict stub.
#![allow(clippy::unwrap_used, reason = "E2E assertions")]
use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    routing::{get, post},
};
use butler_e2e::e2e::{
    HarnessError,
    config::ModelChoice,
    scenario::{Scenario, Setup},
};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex},
};

type Requests = Arc<Mutex<Vec<Value>>>;

async fn reply(
    State(requests): State<Requests>,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    let valid = body["max_tokens"].as_u64().is_some_and(|n| n > 0)
        && body["tools"].as_array().into_iter().flatten().all(|tool| {
            let schema = &tool["input_schema"];
            schema["type"] == "object"
                && ["oneOf", "anyOf", "allOf"]
                    .iter()
                    .all(|key| schema.get(key).is_none())
        });
    requests.lock().unwrap().push(body.clone());
    if !valid {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"type":"error", "error":{
            "type":"invalid_request_error", "message":"integer max_tokens and object input_schema without root combinators required"}})),
        );
    }
    let tool_round = has_result(&body, "registry");
    let content = if tool_round {
        json!([{"type":"text","text":"Compatible request."}])
    } else if has_result(&body, "describe_registry") {
        json!([{"type":"tool_use","id":"registry","name":"tool_call",
            "input":{"id":"native:list_tool_capabilities","arguments":{"include_disabled":true}}}])
    } else {
        json!([{"type":"tool_use","id":"describe_registry","name":"tool_describe",
            "input":{"ids":["native:list_tool_capabilities"]}}])
    };
    (
        StatusCode::OK,
        Json(
            json!({"id":"msg_compatibility","type":"message","role":"assistant",
        "model":body["model"],"content":content,
        "stop_reason":if tool_round {"end_turn"} else {"tool_use"},"usage":{"input_tokens":100,"output_tokens":10}}),
        ),
    )
}

#[tokio::test]
async fn anthropic_requests_accept_registered_tool_schemas() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let base = format!("http://{}/v1", listener.local_addr()?);
    let requests = Requests::default();
    let app = Router::new()
        .route("/v1/messages", post(reply))
        .route("/v1/models", get(|| async { Json(json!({"data":[]})) }))
        .with_state(requests.clone());
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let s = Setup::new("ANTHROPIC-REQUESTS")?
        .env("BUTLER_ANTHROPIC_BASE_URL", &base)
        .env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1")
        .start()
        .await?;
    let saved =
        s.gw.post(
            "/credentials",
            json!({"provider_id":"anthropic",
        "api_key":"sk-ant-e2e-placeholder"}),
        )
        .await?;
    assert_eq!(saved.status, 201, "{}", saved.text);
    let registered =
        s.gw.post(
            "/model-catalog/registered-models",
            json!({
        "provider_id":"anthropic","model_id":"claude-haiku-4-5","auth_type":"api_key",
        "credential_id":saved.data()["credential"]["id"]}),
        )
        .await?;
    assert_eq!(registered.status, 201, "{}", registered.text);
    let selected = s
        .select_model(&ModelChoice {
            model: "anthropic/claude-haiku-4-5".into(),
            effort: None,
        })
        .await?;
    assert_eq!(selected.status, 200, "{}", selected.text);
    requests.lock().unwrap().clear();
    let (turn_id, turn) = s.turn("general", "Reply briefly.").await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let expected = registered_tools(&s, &turn_id)?;
    assert!(!expected.is_empty());
    let bodies = requests.lock().unwrap().clone();
    assert_ne!(bodies, [] as [serde_json::Value; 0]);
    for body in &bodies {
        assert!(body["max_tokens"].as_u64().is_some());
        let tools = body["tools"].as_array().unwrap();
        let names = tools
            .iter()
            .map(|tool| tool["name"].as_str().unwrap().to_owned())
            .collect::<BTreeSet<_>>();
        assert_eq!(names, expected);
        assert_eq!(tools.len(), expected.len(), "duplicate tools");
        for tool in tools {
            validate_schema(&tool["input_schema"]);
        }
        let edit = tools
            .iter()
            .find(|tool| tool["name"] == "edit_file")
            .unwrap();
        assert!(
            edit["description"]
                .as_str()
                .unwrap()
                .contains("Input variant constraints")
        );
        assert!(edit["input_schema"].get("oneOf").is_none());
        assert!(edit["input_schema"]["properties"].get("edits").is_some());
        assert!(edit["input_schema"]["properties"].get("old_text").is_some());
        eprintln!(
            "Anthropic gateway stub: {} tools, integer max_tokens",
            tools.len()
        );
    }
    s.finish().await?;
    server.abort();
    Ok(())
}

// Read the product's gate-filtered registry and active turn selection, independent
// of the provider request being checked. The harness does not link product crates.
fn registered_tools(s: &Scenario, turn_id: &str) -> Result<BTreeSet<String>, HarnessError> {
    let db = butler_platform::sqlite::open_with_flags(
        s.sandbox.data.join("agent-runtime/btcc.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let raw: String = db.query_row(
        "SELECT result_json FROM btcc_guided_tool_calls WHERE turn_id=?1 AND tool_name='list_tool_capabilities'",
        [turn_id],
        |row| row.get(0),
    )?;
    let result: Value = serde_json::from_str(&raw)?;
    assert_eq!(result["ok"], true, "{result}");
    Ok(result["capabilities"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|tool| tool["current_turn_selected"] == true)
        .map(|tool| tool["name"].as_str().unwrap().to_owned())
        .collect())
}

fn validate_schema(schema: &Value) {
    assert_eq!(schema["type"], "object");
    assert!(schema["properties"].is_object());
    for key in ["oneOf", "anyOf", "allOf"] {
        assert!(schema.get(key).is_none(), "root {key}: {schema}");
    }
    for name in schema["required"].as_array().into_iter().flatten() {
        assert!(schema["properties"].get(name.as_str().unwrap()).is_some());
    }
    validate_refs(schema, schema);
}

fn validate_refs(node: &Value, root: &Value) {
    match node {
        Value::Object(object) => {
            if let Some(reference) = object.get("$ref").and_then(Value::as_str) {
                assert!(
                    reference.starts_with("#/"),
                    "external reference: {reference}"
                );
                assert!(
                    root.pointer(&reference[1..]).is_some(),
                    "unresolved {reference}"
                );
            }
            for value in object.values() {
                validate_refs(value, root);
            }
        }
        Value::Array(values) => {
            for value in values {
                validate_refs(value, root);
            }
        }
        _ => {}
    }
}

fn has_result(body: &Value, id: &str) -> bool {
    body["messages"].as_array().unwrap().iter().any(|message| {
        message["content"].as_array().is_some_and(|blocks| {
            blocks
                .iter()
                .any(|block| block["type"] == "tool_result" && block["tool_use_id"] == id)
        })
    })
}
