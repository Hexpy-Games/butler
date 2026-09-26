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
