use std::sync::Arc;

use super::*;
use crate::workspace::{WorkspaceFiles, WorkspaceMutations};

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
