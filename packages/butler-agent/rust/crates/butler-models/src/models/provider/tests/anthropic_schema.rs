//! Standalone full catalog wire regression.
use super::*;
use butler_turn::btcc::ModelRoundTool;
use serde_json::{Value, json};

const CATALOG: &str =
    include_str!("../../../../../butler-runtime/src/capabilities/catalog/catalog.json");

// test-category: format-pin
#[tokio::test]
async fn all_registered_tools_through_stub() {
    let catalog_json: Value = serde_json::from_str(CATALOG).unwrap();
    let raw = catalog_json["rawDefinitions"].as_object().unwrap();
    let projected = catalog_json["tools"].as_array().unwrap();
    assert!(raw.len() >= 35);
    assert_eq!(raw.len(), projected.len());
    for definitions in [
        raw.values().cloned().collect::<Vec<_>>(),
        projected
            .iter()
            .map(|tool| tool["definition"].clone())
            .collect(),
    ] {
        serialize_catalog(&definitions).await;
    }
    variants_and_integer_fields();
    eprintln!(
        "Anthropic schemas: {} registered + {} phase definitions validated",
        raw.len(),
        projected.len()
    );
}

async fn serialize_catalog(definitions: &[Value]) {
    let tools: Vec<ModelRoundTool> = definitions
        .iter()
        .map(|tool| ModelRoundTool {
            name: tool["name"].as_str().unwrap().into(),
            description: tool["description"].as_str().unwrap().into(),
            parameters: tool["parameters"].as_object().unwrap().clone(),
            concurrency_safe: None,
            tool_contract_version: None,
        })
        .collect();
    let payload = br#"{"content":[{"type":"text","text":"ok"}],"usage":{}}"#;
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        payload.len(),
        String::from_utf8_lossy(payload)
    );
    let (endpoint, stub) = server(vec![response.into_bytes()]).await;
    let (catalog, snapshot) = catalog();
    let metadata = snapshot
        .find_model_metadata(Some("anthropic/claude-haiku-4-5"))
        .unwrap();
    let provider = ModelProvider::new(
        crate::models::provider_http_client().unwrap(),
        Arc::new(Config {
            metadata,
            endpoint,
            snapshot,
            codex: false,
        }),
        Arc::new(Observations::default()),
        catalog,
        Arc::new(TestClock::at(1_000)),
        Arc::new(Metrics),
    );
    let mut input = request(
        "anthropic/claude-haiku-4-5",
        &[],
        &ReasoningEffort::None,
        CancellationToken::new(),
        None,
    );
    input.tools = &tools;
    provider.run_round(input).await.unwrap();
    let wire = stub.await.unwrap();
    let offset = wire
        .windows(4)
        .position(|bytes| bytes == b"\r\n\r\n")
        .unwrap()
        + 4;
    let body: Value = serde_json::from_slice(&wire[offset..]).unwrap();
    assert_eq!(body["max_tokens"].as_u64(), Some(64));
    let serialized = body["tools"].as_array().unwrap();
    assert_eq!(serialized.len(), definitions.len());
    for (tool, original) in serialized.iter().zip(definitions) {
        validate_schema(&tool["input_schema"]);
        assert_eq!(tool["name"], original["name"]);
        if ["oneOf", "anyOf", "allOf"]
            .iter()
            .any(|key| original["parameters"].get(key).is_some())
        {
            assert!(
                tool["description"]
                    .as_str()
                    .unwrap()
                    .contains("Input variant constraints")
            );
        }
    }
    if let Ok(path) = std::env::var("BUTLER_TEST_ANTHROPIC_TOOLS_OUTPUT") {
        std::fs::write(path, serde_json::to_vec_pretty(serialized).unwrap()).unwrap();
    }
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

fn variants_and_integer_fields() {
    let (_, snapshot) = catalog();
    let config = super::serialization::carrier_config(
        snapshot
            .find_model_metadata(Some("anthropic/claude-haiku-4-5"))
            .unwrap(),
        "claude-haiku-4-5",
    );
    for keyword in ["oneOf", "anyOf", "allOf"] {
        let parameters = json!({"type":"object","definitions":{"Item":{"type":"string"}},
            keyword:[{"properties":{"shared":{"type":"string"},"left":{"$ref":"#/definitions/Item"}},"required":["shared","left"]},
                {"properties":{"shared":{"type":"integer"},"right":{"type":"boolean"}},"required":["shared","right"]}]});
        let tools = [ModelRoundTool {
            name: "variants".into(),
            description: "Choose a variant".into(),
            parameters: parameters.as_object().unwrap().clone(),
            concurrency_safe: None,
            tool_contract_version: None,
        }];
        for max in [
            None,
            Some(4096.0),
            Some(321.0),
            Some(2.5),
            Some(f64::NAN),
            Some(-1.0),
        ] {
            let mut input = request(
                "anthropic/claude-haiku-4-5",
                &[],
                &ReasoningEffort::Low,
                CancellationToken::new(),
                None,
            );
            input.tools = &tools;
            input.max_output_tokens = max;
            let body = serialize::body(&input, &config, serialize::Carrier::Anthropic).unwrap();
            let repeated = serialize::body(&input, &config, serialize::Carrier::Anthropic).unwrap();
            assert_eq!(
                serde_json::to_vec(&body).unwrap(),
                serde_json::to_vec(&repeated).unwrap()
            );
            assert_eq!(
                body["max_tokens"].as_u64(),
                Some(if max == Some(321.0) { 321 } else { 4096 })
            );
            if let Some(budget) = body.pointer("/thinking/budget_tokens") {
                assert_eq!(budget.as_u64(), Some(1024));
            }
            let schema = &body["tools"][0]["input_schema"];
            validate_schema(schema);
            assert_eq!(
                schema["required"],
                if keyword == "allOf" {
                    json!(["left", "right", "shared"])
                } else {
                    json!(["shared"])
                }
            );
            assert_eq!(schema["properties"].as_object().unwrap().len(), 3);
            assert_eq!(
                schema["properties"]["shared"]["anyOf"]
                    .as_array()
                    .unwrap()
                    .len(),
                2
            );
            for carrier in [
                serialize::Carrier::Responses,
                serialize::Carrier::Chat { stream: false },
            ] {
                let other = serialize::body(&input, &config, carrier).unwrap();
                let original = if matches!(carrier, serialize::Carrier::Responses) {
                    &other["tools"][0]["parameters"]
                } else {
                    &other["tools"][0]["function"]["parameters"]
                };
                assert_eq!(
                    serde_json::to_vec(original).unwrap(),
                    serde_json::to_vec(&parameters).unwrap()
                );
            }
        }
    }
}
