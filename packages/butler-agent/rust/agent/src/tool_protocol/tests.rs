use serde_json::json;

use super::*;

#[test]
fn catalog_and_guided_calls_match_actual_bun_source() {
    let fixture: Value = serde_json::from_str(include_str!("fixture.json")).unwrap();
    for case in fixture["catalog"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let actual = parse_tool_catalog_id(id).map(|parsed| {
            let provider = match parsed.provider {
                ToolCatalogProvider::Native => "native",
                ToolCatalogProvider::Mcp => "mcp",
                ToolCatalogProvider::Plugin => "plugin",
            };
            json!({"provider":provider,"namespace":parsed.namespace,"name":parsed.name})
        });
        assert_eq!(actual.unwrap_or(Value::Null), case["expected"], "{id}");
    }
    for case in fixture["calls"].as_array().unwrap() {
        let input = &case["input"];
        let args = input["args"].as_object().unwrap();
        let actual = normalize_guided_tool_call(input["toolName"].as_str().unwrap(), args);
        assert_eq!(
            actual.name.as_ref(),
            case["expected"]["name"].as_str().unwrap(),
            "{input}"
        );
    }
}
