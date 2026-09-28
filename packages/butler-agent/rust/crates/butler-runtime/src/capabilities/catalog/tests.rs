use std::sync::Arc;

use super::*;
use butler_turn::workspace::{WorkspaceFiles, WorkspaceMutations};

fn capabilities() -> Capabilities {
    Capabilities::new(
        Arc::new(WorkspaceFiles::new(1)),
        Arc::new(WorkspaceMutations::new()),
    )
}

#[test]
fn catalog_validation_rejects_missing_or_changed_registered_contracts() {
    let capabilities = capabilities();
    assert!(matches!(
        ToolCatalog::validate("{", &capabilities),
        Err(CatalogError::InvalidSource(_))
    ));
    assert!(matches!(
        ToolCatalog::validate(r#"{"rawDefinitions":{}}"#, &capabilities),
        Err(CatalogError::RegisteredDefinitionMissing(name)) if name == "read_file"
    ));
    assert!(matches!(
        ToolCatalog::validate(r#"{"rawDefinitions":{"read_file":null}}"#, &capabilities),
        Err(CatalogError::RegisteredDefinitionMismatch(name)) if name == "read_file"
    ));
}

#[test]
fn every_catalog_tool_is_named() {
    let catalog: serde_json::Value = serde_json::from_str(include_str!("catalog.json")).unwrap();
    fn names(value: &serde_json::Value, out: &mut Vec<String>) {
        match value {
            serde_json::Value::Object(map) => {
                for (key, child) in map {
                    if key == "name"
                        && let Some(name) = child.as_str()
                        && name
                            .bytes()
                            .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
                    {
                        out.push(name.to_owned());
                    }
                    names(child, out);
                }
            }
            serde_json::Value::Array(items) => items.iter().for_each(|item| names(item, out)),
            _ => {}
        }
    }
    let mut found = Vec::new();
    names(&catalog, &mut found);
    for name in &found {
        assert!(
            butler_core::tool_protocol::ToolName::parse(name).is_some(),
            "catalog tool {name} has no ToolName"
        );
    }
    for tool in butler_core::tool_protocol::ToolName::ALL {
        assert!(
            found.iter().any(|name| name == tool.as_str()),
            "{tool} is not in the catalog"
        );
    }
}

/// Types, enums, bounds and required keys of a schema, without descriptions.
fn schema_shape(schema: &serde_json::Value) -> serde_json::Value {
    let mut shape = serde_json::Map::new();
    for key in [
        "type",
        "enum",
        "required",
        "minimum",
        "maximum",
        "additionalProperties",
    ] {
        if let Some(value) = schema.get(key) {
            shape.insert(key.into(), value.clone());
        }
    }
    if let Some(properties) = schema.get("properties").and_then(|value| value.as_object()) {
        let properties = properties
            .iter()
            .map(|(name, property)| (name.clone(), schema_shape(property)))
            .collect();
        shape.insert("properties".into(), serde_json::Value::Object(properties));
    }
    serde_json::Value::Object(shape)
}

fn bundled_catalog() -> serde_json::Value {
    serde_json::from_str(include_str!("catalog.json")).unwrap()
}

fn catalog_tool(catalog: &serde_json::Value, name: &str) -> serde_json::Value {
    catalog["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == name)
        .unwrap()
        .clone()
}

fn description(tool: &serde_json::Value) -> String {
    tool["definition"]["description"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[test]
fn wallpaper_tool_schemas_match_their_snapshot() {
    use serde_json::json;
    let catalog = bundled_catalog();
    let (list, set) = (
        catalog_tool(&catalog, "list_wallpapers"),
        catalog_tool(&catalog, "set_wallpaper"),
    );
    let save = catalog_tool(&catalog, "save_wallpaper_module");
    for tool in [&list, &set, &save] {
        let name = tool["name"].as_str().unwrap();
        assert_eq!(
            catalog["rawDefinitions"][name], tool["definition"],
            "{name}"
        );
        assert!(
            catalog["profiles"]["startup"]
                .as_array()
                .unwrap()
                .contains(&json!(name)),
            "{name}"
        );
        assert_eq!(tool["category"], "control");
        assert_eq!(tool["effectBoundary"], tool["definition"]["effectBoundary"]);
    }
    assert_eq!(list["effectBoundary"], "none");
    // A reversible preference write: no Work or plan review, like other
    // turn-local writes; the App's toast undoes it.
    assert_eq!(set["effectBoundary"], "turn_local");
    // Writes only the user's module folder, checked and undone by the user.
    assert_eq!(save["effectBoundary"], "turn_local");
    assert!(description(&set).contains("Call list_wallpapers first"));
    assert!(description(&set).contains("status is error"));
    assert!(description(&list).contains("status"));
    assert!(description(&list).contains("userModuleDirectory"));
    assert_eq!(
        schema_shape(&list["definition"]["parameters"]),
        json!({"type": "object", "required": [], "additionalProperties": false,
               "properties": {"project_id": {"type": "string"}}})
    );
    assert_eq!(
        schema_shape(&save["definition"]["parameters"]),
        json!({"type": "object", "required": ["id", "manifest", "shader"],
               "additionalProperties": false,
               "properties": {"id": {"type": "string"}, "manifest": {"type": "object"},
                              "shader": {"type": "string"}, "overlay": {"type": "string"}}})
    );
    let module = json!({"module": {"type": "string"}, "params": {"type": "object"},
                        "paramsDark": {"type": "object"}});
    assert_eq!(
        schema_shape(&set["definition"]["parameters"]),
        json!({
            "type": "object", "required": ["scope", "source"], "additionalProperties": false,
            "properties": {
                "scope": {"type": "string", "enum": ["global", "current_project", "project"]},
                "project_id": {"type": "string"},
                "source": {
                    "type": "object", "required": ["kind"], "additionalProperties": false,
                    "properties": {
                        "kind": {"type": "string",
                                 "enum": ["live", "image", "image_from_attachment", "none", "inherit"]},
                        "module": {"type": "string"},
                        "params": {"type": "object"},
                        "paramsDark": {"type": "object"},
                        "asset": {"type": "string"},
                        "attachment_id": {"type": "string"},
                        "fit": {"type": "string", "enum": ["cover", "contain"]},
                        "dim": {"type": "number", "minimum": 0, "maximum": 1},
                        "blur": {"type": "number", "minimum": 0, "maximum": 1},
                        "filter": {"type": "object", "required": ["module"],
                                   "additionalProperties": false, "properties": module}
                    }
                }
            }
        })
    );
}

/// The authoring loop the descriptions teach: read the skill through
/// `list_skills` (authorized in every mode), save, fix on error, apply.
#[test]
fn wallpaper_descriptions_teach_the_module_authoring_loop() {
    use serde_json::json;
    let catalog = bundled_catalog();
    let list = description(&catalog_tool(&catalog, "list_wallpapers"));
    let set = description(&catalog_tool(&catalog, "set_wallpaper"));
    let save = description(&catalog_tool(&catalog, "save_wallpaper_module"));
    for text in [&list, &save] {
        assert!(text.contains("native:list_skills"), "{text}");
        assert!(text.contains("\"wallpaper-authoring\""), "{text}");
    }
    assert!(list.contains("save_wallpaper_module"), "{list}");
    assert!(set.contains("save_wallpaper_module"), "{set}");
    for part in [
        "\"ok\"",
        "\"error\"",
        "\"unknown\"",
        "save again",
        "set_wallpaper",
    ] {
        assert!(save.contains(part), "{part}");
    }
    assert!(
        catalog["profiles"]["startup"]
            .as_array()
            .unwrap()
            .contains(&json!("list_skills"))
    );
    let skills = catalog_tool(&catalog, "list_skills");
    assert_eq!(
        catalog["rawDefinitions"]["list_skills"],
        skills["definition"]
    );
    assert_eq!(
        schema_shape(&skills["definition"]["parameters"]),
        json!({"type": "object", "required": [], "additionalProperties": false,
               "properties": {"name": {"type": "string"}}})
    );
}
