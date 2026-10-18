//! Rich schema coverage through the production provider port and strict HTTP stub.
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
            "choice":{"anyOf":[{"const":"a"}],"oneOf":[{"const":"b"}]},
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
            .contains("\"pattern\":\"^a\"")
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
        json!([{"enum":["a"]},{"enum":["b"]}])
    );
    let unknown = &properties["unknown"];
    assert_eq!(unknown.as_object().unwrap().len(), 1);
    assert!(
        unknown["description"]
            .as_str()
            .unwrap()
            .starts_with("Original\nConstraints:")
    );
    for key in ["default", "examples", "not", "custom"] {
        assert!(unknown["description"].as_str().unwrap().contains(key));
    }
    assert!(
        properties["loop"]["description"]
            .as_str()
            .unwrap()
            .contains("Recursive reference")
    );
    assert_eq!(properties["escaped"]["type"], "integer");
    assert!(
        properties["missing"]["description"]
            .as_str()
            .unwrap()
            .contains("#/$defs/missing")
    );
    assert_eq!(properties["simple"]["required"], json!(["a", "b"]));
    assert_eq!(properties["simple"]["properties"]["b"]["type"], "number");
    assert_eq!(properties["conflict"]["type"], "string");
    assert!(
        properties["conflict"]["description"]
            .as_str()
            .unwrap()
            .contains("allOf")
    );
    assert!(properties["closed"].get("properties").is_none());
    assert!(
        properties["closed"]["description"]
            .as_str()
            .unwrap()
            .contains("allOf")
    );
}
