use super::*;
use crate::btcc::subsessions::read_subsession_metadata;

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
