//! MCP formatting for the legacy graph's read-only Cognition facade.

use crate::cognition;

pub(super) fn query(
    data_root: &std::path::Path,
    query: &str,
    entity_type: Option<&str>,
    project: Option<&str>,
    hops: u32,
) -> String {
    match cognition::read_mcp_legacy_graph(data_root, query, entity_type, project, hops) {
        Ok(value) => value,
        Err(error) => format!("Graph unavailable: {error}"),
    }
}
