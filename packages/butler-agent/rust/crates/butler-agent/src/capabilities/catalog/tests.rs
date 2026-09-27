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
