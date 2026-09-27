use super::*;
use crate::btcc::subsessions::read_subsession_metadata;

#[test]
fn eol_validation_rejects_missing_or_duplicate_exact_profile_section() {
    let missing = ContextAssembly::default();
    assert_eq!(
        subsession::validate_assembly(&missing, false)
            .unwrap_err()
            .code(),
        "butler_eol_context_assembly_invalid"
    );
    let section = ContextSection {
        id: "eol".into(),
        title: "EOL".into(),
        content: "exact".into(),
        region: Some("live_configuration".into()),
        projection_class: "profile".into(),
        scope_kind: "user".into(),
        source: None,
    };
    let duplicate = ContextAssembly {
        live_configuration: vec![section.clone(), section],
        ..ContextAssembly::default()
    };
    assert_eq!(
        subsession::validate_assembly(&duplicate, false)
            .unwrap_err()
            .code(),
        "butler_eol_context_assembly_invalid"
    );
}

#[test]
fn subsession_scope_preserves_source_normalization_and_legacy_mode() {
    let value = json!({
        "relation_id":" relation ", "delegation_id":"delegation", "task_id":"task",
        "allowed_tools_and_effects":["write_file:workspace","edit_file:workspace","write_file:workspace"],
        "mutation_scope":["./src\\nested//","README.md"]
    });
    let result = read_subsession_metadata(Some(&value)).unwrap().unwrap();
    assert_eq!(result.relation_id, "relation");
    assert_eq!(
        result.allowed_tools_and_effects,
        vec!["edit_file:workspace", "write_file:workspace"]
    );
    assert_eq!(result.mutation_scope, vec!["README.md", "src/nested/"]);
}
