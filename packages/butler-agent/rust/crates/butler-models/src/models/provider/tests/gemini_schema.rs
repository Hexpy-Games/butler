//! Gemini wire-format checks invoked by the existing format-pin serialization test.
use super::*;
use butler_turn::btcc::ModelRoundTool;
use serde_json::{Value, json};

pub(super) fn tool() -> ModelRoundTool {
    let schema = json!({
        "$defs":{
            "entry":{"type":["string","null"],"pattern":"^a","minLength":2},
            "loop":{"$ref":"#/$defs/loop"},"a/b":{"type":"integer"},
            "closed":{"type":"object","additionalProperties":false,"properties":{"x":{"type":"integer"}}}
        },
        "definitions":{"flag":{"const":true}},
        "type":"object","additionalProperties":{"$ref":"#/definitions/flag"},
        "properties":{
            "entries":{"type":"array","items":{"$ref":"#/$defs/entry"},
                "prefixItems":[{"const":7}],"uniqueItems":true},
            "choice":{"anyOf":[{"required":["a"]},{"required":["b"]}],
                "oneOf":[{"required":["c"]},{"required":["d"]}]},
            "one":{"oneOf":[{"const":"a"},{"const":"b"}]},
            "keywords":{"properties":{"oneOf":{"type":"string"},"$ref":{"type":"number"}}},
            "unknown":{"description":"Original","default":42,"examples":[1],"not":{"const":0},"custom":1},
            "loop":{"$ref":"#/$defs/loop"},"escaped":{"$ref":"#/$defs/a~1b"},
            "missing":{"$ref":"#/$defs/missing"},"closedRef":{"$ref":"#/$defs/closed"},
            "simple":{"type":"object","properties":{"a":{"type":"string"}},"required":["a"],
                "allOf":[{"properties":{"b":{"type":"number"}},"required":["b"]}]},
            "conflict":{"type":"string","description":"Original","allOf":[{"type":"number"}]},
            "closed":{"type":"object","additionalProperties":false,
                "allOf":[{"properties":{"b":{"type":"number"}}}]}
        },
        "$schema":"unused","$id":"unused","$comment":"unused"
    });
    ModelRoundTool {
        name: "schema_probe".into(),
        description: "Schema projection probe".into(),
        parameters: schema.as_object().unwrap().clone(),
        concurrency_safe: None,
        transcript_visibility: None,
        handler_validates_arguments: None,
        tool_contract_version: None,
    }
}

pub(super) fn check(body: &Value) {
    let declaration = &body["tools"][0]["functionDeclarations"][0];
    let projected = declaration
        .get("parametersJsonSchema")
        .or_else(|| declaration.get("parameters"))
        .unwrap();
    allowed_keywords(projected);
    assert_eq!(projected["type"], "object");
    for key in ["$defs", "definitions", "$schema", "$id", "$comment"] {
        assert!(projected.get(key).is_none());
    }
    assert_eq!(projected["additionalProperties"]["enum"], json!([true]));
    let properties = &projected["properties"];
    assert_eq!(properties["closedRef"]["additionalProperties"], false);
    assert_eq!(
        properties["closedRef"]["properties"]["x"]["type"],
        "integer"
    );
    let entries = &properties["entries"];
    assert_eq!(entries["items"]["type"], json!(["string", "null"]));
    assert!(entries["items"].get("pattern").is_none());
    assert!(
        entries["items"]["description"]
            .as_str()
            .unwrap()
            .contains("^a")
    );
    assert_eq!(entries["prefixItems"][0]["enum"], json!([7]));
    assert!(
        entries["description"]
            .as_str()
            .unwrap()
            .contains("uniqueItems")
    );
    assert_eq!(
        properties["choice"]["anyOf"],
        json!([{"required":["a"]},{"required":["b"]}])
    );
    let choice_text = properties["choice"]["description"].as_str().unwrap();
    for constraint in ["oneOf", "required", "c", "d"] {
        assert!(choice_text.contains(constraint));
    }
    assert_eq!(
        properties["one"]["anyOf"],
        json!([{"enum":["a"]},{"enum":["b"]}])
    );
    assert_eq!(
        properties["keywords"]["properties"]["oneOf"]["type"],
        "string"
    );
    assert_eq!(
        properties["keywords"]["properties"]["$ref"]["type"],
        "number"
    );
    let unknown = &properties["unknown"];
    assert!(
        unknown["description"]
            .as_str()
            .unwrap()
            .contains("Original")
    );
    for key in ["default", "examples", "not", "custom"] {
        assert!(unknown["description"].as_str().unwrap().contains(key));
    }
    assert!(
        properties["loop"]["description"]
            .as_str()
            .unwrap()
            .contains("#/$defs/loop")
    );
    assert_eq!(properties["escaped"]["type"], "integer");
    assert!(
        properties["missing"]["description"]
            .as_str()
            .unwrap()
            .contains("#/$defs/missing")
    );
    let required = properties["simple"]["required"].as_array().unwrap();
    assert_eq!(required.len(), 2);
    assert!(required.contains(&json!("a")) && required.contains(&json!("b")));
    assert_eq!(properties["simple"]["properties"]["b"]["type"], "number");
    assert_eq!(properties["conflict"]["type"], "string");
    assert!(
        properties["conflict"]["description"]
            .as_str()
            .unwrap()
            .contains("allOf")
    );
    assert_eq!(properties["closed"]["additionalProperties"], false);
    assert!(properties["closed"].get("properties").is_none());
    assert!(
        properties["closed"]["description"]
            .as_str()
            .unwrap()
            .contains("allOf")
    );
}

fn allowed_keywords(node: &Value) {
    let allowed = [
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
    for (key, value) in node.as_object().unwrap() {
        assert!(
            allowed.contains(&key.as_str()),
            "unsupported keyword: {key}"
        );
        match key.as_str() {
            "properties" => {
                for schema in value.as_object().unwrap().values() {
                    allowed_keywords(schema);
                }
            }
            "items" => allowed_keywords(value),
            "additionalProperties" if value.is_object() => allowed_keywords(value),
            "prefixItems" | "anyOf" => {
                for schema in value.as_array().unwrap() {
                    allowed_keywords(schema);
                }
            }
            _ => {}
        }
    }
}

pub(super) fn schemas_and_plain_tool_results() {
    let (_, snapshot) = catalog();
    let model = "google/gemini-3.8-flash";
    let config = super::serialization::carrier_config(
        snapshot.find_model_metadata(Some(model)).unwrap(),
        model,
    );
    let tools = [tool()];
    let original = tools[0].parameters.clone();
    for text in [
        "42",
        "\"x\"",
        "true",
        "[1,2]",
        "null",
        "plain",
        "{\"ok\":true}",
    ] {
        let mut message = ModelRoundMessage::user(text.into(), None);
        message.role = ModelRoundRole::Tool;
        message.name = Some("plain_result".into());
        message.tool_call_id = Some("call-1".into());
        let messages = [message];
        let mut input = request(
            model,
            &messages,
            &ReasoningEffort::Medium,
            CancellationToken::new(),
            None,
        );
        input.tools = &tools;
        let body = serialize::body(&input, &config, serialize::Carrier::Gemini).unwrap();
        assert_eq!(tools[0].parameters, original);
        check(&body);
        let response = &body["contents"][0]["parts"][0]["functionResponse"]["response"];
        let object = response
            .as_object()
            .expect("tool response must be a JSON object");
        let value = serde_json::from_str::<Value>(text).unwrap_or(json!(text));
        assert!(
            response == &value || object.values().any(|item| item == &value),
            "tool response must preserve the original value: {response}"
        );
    }
}
