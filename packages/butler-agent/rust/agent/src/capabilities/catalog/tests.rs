use std::sync::Arc;

use super::*;
use crate::workspace::{NativeWorkspaceFiles, WorkspaceMutations};

fn capabilities() -> NativeCapabilities {
    NativeCapabilities::new(
        Arc::new(NativeWorkspaceFiles::new(1)),
        Arc::new(WorkspaceMutations::new()),
    )
}

#[test]
fn native_definitions_match_source_and_guided_data_matches_bun() {
    let catalog = NativeToolCatalog::load(&capabilities()).unwrap();
    let mut source: Value = serde_json::from_str(catalog.source()).unwrap();
    let raw = source
        .as_object_mut()
        .unwrap()
        .remove("rawDefinitions")
        .unwrap();
    assert!(raw["write_file"].is_object());
    let expected: Value = serde_json::from_str(include_str!(
        "../../btcc/guided_turn/phase/catalog-bun-golden.json"
    ))
    .unwrap();
    assert_eq!(source, expected);
    assert!(std::ptr::eq(catalog.source(), SOURCE));
}

#[test]
fn catalog_validation_rejects_missing_or_changed_registered_contracts() {
    let capabilities = capabilities();
    assert!(matches!(
        NativeToolCatalog::validate("{", &capabilities),
        Err(CatalogError::InvalidSource(_))
    ));
    assert!(matches!(
        NativeToolCatalog::validate(r#"{"rawDefinitions":{}}"#, &capabilities),
        Err(CatalogError::RegisteredDefinitionMissing(name)) if name == "read_file"
    ));
    assert!(matches!(
        NativeToolCatalog::validate(r#"{"rawDefinitions":{"read_file":null}}"#, &capabilities),
        Err(CatalogError::RegisteredDefinitionMismatch(name)) if name == "read_file"
    ));
}
