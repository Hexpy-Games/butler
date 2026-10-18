//! Gemini wire compatibility through the product gateway and a strict stub.
#![allow(clippy::unwrap_used, reason = "E2E assertions")]
use axum::{
    Json, Router,
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use butler_e2e::e2e::{HarnessError, config::ModelChoice, scenario::Setup};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
};

type Requests = Arc<Mutex<Vec<(Value, Result<(), String>)>>>;

// https://ai.google.dev/api/generate-content#Schema
const SCHEMA_FIELDS: &[&str] = &[
    "type",
    "format",
    "title",
    "description",
    "nullable",
    "enum",
    "maxItems",
    "minItems",
    "properties",
    "required",
    "minProperties",
    "maxProperties",
    "minLength",
    "maxLength",
    "pattern",
    "example",
    "anyOf",
    "propertyOrdering",
    "default",
    "items",
    "minimum",
    "maximum",
];

// https://ai.google.dev/gemini-api/docs/structured-output
const JSON_SCHEMA_FIELDS: &[&str] = &[
    "type",
    "title",
    "description",
    "properties",
    "required",
    "additionalProperties",
    "enum",
    "format",
    "minimum",
    "maximum",
    "items",
    "prefixItems",
    "minItems",
    "maxItems",
    "anyOf",
];
const SIGNATURE: &str = "c3R1Yi1zaWduYXR1cmU=";

fn invalid(field: &str, path: &str) -> String {
    format!(
        "Invalid JSON payload received. Unknown name \"{field}\" at '{path}': Cannot find field."
    )
}

fn schema(node: &Value, path: &str, json_schema: bool) -> Result<(), String> {
    let object = node
        .as_object()
        .ok_or_else(|| format!("{path}: Schema must be an object"))?;
    for (key, value) in object {
        if !(if json_schema {
            JSON_SCHEMA_FIELDS
        } else {
            SCHEMA_FIELDS
        })
        .contains(&key.as_str())
        {
            return Err(invalid(key, path));
        }
        let child = format!("{path}.{key}");
        match key.as_str() {
            "type" if !json_schema && !value.is_string() => {
                return Err(format!("{child}: type must be a string"));
            }
            "properties" => {
                for (name, property) in value
                    .as_object()
                    .ok_or_else(|| format!("{child}: properties must be an object"))?
                {
                    schema(property, &format!("{child}.{name}"), json_schema)?;
                }
            }
            "items" => schema(value, &child, json_schema)?,
            "additionalProperties" if value.is_object() => schema(value, &child, true)?,
            "anyOf" | "prefixItems" => {
                for (index, variant) in value
                    .as_array()
                    .ok_or_else(|| format!("{child}: anyOf must be an array"))?
                    .iter()
                    .enumerate()
                {
                    schema(variant, &format!("{child}[{index}]"), json_schema)?;
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn validate(body: &Value) -> Result<(), String> {
    for (index, content) in body["contents"]
        .as_array()
        .ok_or("contents must be an array")?
        .iter()
        .enumerate()
    {
        if !matches!(content["role"].as_str(), Some("user" | "model")) {
            return Err(format!("contents[{index}].role must be user or model"));
        }
        for part in content["parts"]
            .as_array()
            .ok_or("parts must be an array")?
        {
            if part.get("functionCall").is_some() && part["thoughtSignature"] != SIGNATURE {
                return Err("replayed functionCall thoughtSignature differs".into());
            }
            if let Some(result) = part.get("functionResponse")
                && !result["response"].is_object()
            {
                return Err(format!(
                    "contents[{index}].functionResponse.response must be an object"
                ));
            }
        }
    }
    for (i, tool) in body["tools"].as_array().into_iter().flatten().enumerate() {
        for (j, declaration) in tool["functionDeclarations"]
            .as_array()
            .ok_or("functionDeclarations must be an array")?
            .iter()
            .enumerate()
        {
            let path = format!("tools[{i}].function_declarations[{j}]");
            if declaration["name"].as_str().is_none_or(str::is_empty) {
                return Err(format!("{path}.name is required"));
            }
            if declaration.get("parameters").is_some()
                && declaration.get("parametersJsonSchema").is_some()
            {
                return Err(format!(
                    "{path}: parameters and parametersJsonSchema are mutually exclusive"
                ));
            }
            if let Some(value) = declaration.get("parameters") {
                schema(value, &format!("{path}.parameters"), false)?;
            }
            if let Some(value) = declaration.get("parametersJsonSchema") {
                schema(value, &format!("{path}.parametersJsonSchema"), true)?;
                if value["type"] != "object" {
                    return Err(format!(
                        "{path}.parametersJsonSchema must be an object schema"
                    ));
                }
            }
        }
    }
    Ok(())
}

async fn reply(
    State(requests): State<Requests>,
    Query(query): Query<BTreeMap<String, String>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let result = if query.get("alt").map(String::as_str) != Some("sse") {
        Err("alt=sse is required".into())
    } else if headers.get("x-goog-api-key").and_then(|v| v.to_str().ok())
        != Some("AIza-e2e-placeholder")
    {
        Err("x-goog-api-key is required".into())
    } else {
        validate(&body)
    };
    requests
        .lock()
        .unwrap()
        .push((body.clone(), result.clone()));
    if let Err(message) = result {
        eprintln!("Gemini stub HTTP 400: {message}");
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":{
            "code":400,"message":message,"status":"INVALID_ARGUMENT"}})),
        )
            .into_response();
    }
    let done = has_result(&body, "tool_describe");
    let part = if done {
        json!({"text":"Compatible Gemini request."})
    } else {
        json!({"functionCall":{"name":"tool_describe","args":{"ids":["native:list_tool_capabilities"]}},
            "thoughtSignature":SIGNATURE})
    };
    let response = json!({"candidates":[{"content":{"role":"model","parts":[part]},
        "finishReason":"STOP","index":0}],
        "usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":10,"totalTokenCount":110},
        "modelVersion":"gemini-3.8-flash"});
    (
        [("content-type", "text/event-stream")],
        format!("data: {response}\r\n\r\n"),
    )
        .into_response()
}

fn has_result(body: &Value, name: &str) -> bool {
    body["contents"].as_array().unwrap().iter().any(|content| {
        content["parts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|part| part["functionResponse"]["name"] == name)
    })
}

struct Server(tokio::task::JoinHandle<()>);
impl Drop for Server {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[tokio::test]
async fn gemini_requests_accept_registered_tool_schemas() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let base = format!("http://{}/v1beta", listener.local_addr()?);
    let requests = Requests::default();
    let app = Router::new()
        .route(
            "/v1beta/models",
            get(|| async {
                Json(json!({"models":[{
            "name":"models/gemini-3.8-flash","displayName":"Gemini 3.8 Flash",
            "supportedGenerationMethods":["generateContent"],"inputTokenLimit":1_048_576,
            "outputTokenLimit":65_536}]}))
            }),
        )
        .route(
            "/v1beta/models/gemini-3.8-flash:streamGenerateContent",
            post(reply),
        )
        .with_state(requests.clone());
    let _server = Server(tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    }));
    let s = Setup::new("GEMINI-REQUESTS")?
        .env("BUTLER_GOOGLE_BASE_URL", &base)
        .env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1")
        .start()
        .await?;
    let saved =
        s.gw.post(
            "/credentials",
            json!({
        "provider_id":"google","api_key":"AIza-e2e-placeholder"}),
        )
        .await?;
    assert_eq!(saved.status, 201, "{}", saved.text);
    let registered =
        s.gw.post(
            "/model-catalog/registered-models",
            json!({
        "provider_id":"google","model_id":"gemini-3.8-flash","auth_type":"api_key",
        "credential_id":saved.data()["credential"]["id"]}),
        )
        .await?;
    assert_eq!(registered.status, 201, "{}", registered.text);
    let selected = s
        .select_model(&ModelChoice {
            model: "google/gemini-3.8-flash".into(),
            effort: None,
        })
        .await?;
    assert_eq!(selected.status, 200, "{}", selected.text);
    requests.lock().unwrap().clear();
    let (turn_id, turn) = s.turn("general", "Reply briefly.").await?;
    let bodies = requests.lock().unwrap().clone();
    for (_, result) in &bodies {
        assert!(
            result.is_ok(),
            "Gemini HTTP 400: {}",
            result.as_ref().unwrap_err()
        );
    }
    assert_eq!(turn["state"], "delivered", "{turn}");
    let messages = s.gw.messages("general").await?;
    let answer = messages
        .iter()
        .rev()
        .find(|message| message["role"] == "assistant")
        .unwrap();
    assert_eq!(answer["text"], "Compatible Gemini request.");
    assert_eq!(bodies.len(), 2, "tool call, final");
    for (body, _) in &bodies {
        let tools = body["tools"][0]["functionDeclarations"].as_array().unwrap();
        let names = tools
            .iter()
            .map(|tool| tool["name"].as_str().unwrap().to_owned())
            .collect::<BTreeSet<_>>();
        assert!(!names.is_empty());
        assert_eq!(tools.len(), names.len(), "duplicate tools");
        for tool in tools {
            assert!(tool.get("parameters").is_some() || tool.get("parametersJsonSchema").is_some());
        }
        eprintln!(
            "Gemini gateway stub: {} registered tools validated",
            tools.len()
        );
    }
    assert!(has_result(&bodies[1].0, "tool_describe"));
    let result = bodies[1].0["contents"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|content| content["parts"].as_array().unwrap())
        .find(|part| part["functionResponse"]["name"] == "tool_describe")
        .unwrap();
    assert_eq!(
        result["functionResponse"]["response"]["ok"], true,
        "{result}"
    );
    let db = butler_platform::sqlite::open_with_flags(
        s.sandbox.data.join("agent-runtime/btcc.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let raw: String = db.query_row(
        "SELECT result_json FROM btcc_guided_tool_calls WHERE turn_id=?1 AND tool_name='tool_describe'",
        [turn_id], |row| row.get(0),
    )?;
    let executed: Value = serde_json::from_str(&raw)?;
    assert_eq!(executed["ok"], true);
    assert_eq!(
        executed["descriptions"][0]["id"],
        "native:list_tool_capabilities"
    );
    s.finish().await?;
    Ok(())
}
