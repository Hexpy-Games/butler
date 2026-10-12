//! Selection of importable items from one source, validated before any writes.
use super::McpServers;
use serde::Deserialize;
use std::collections::BTreeSet;

/// Optional choices in a source import request; existing callers import everything.
#[derive(Deserialize)]
pub struct ImportSelection {
    /// Whether to import the instruction file (defaults to true).
    #[serde(default = "include_instructions")]
    pub instructions: bool,
    /// Omitted means all servers; an empty list explicitly means none.
    pub servers: Option<Vec<String>>,
}

fn include_instructions() -> bool {
    true
}

/// A requested name does not identify an importable server in this source.
#[derive(Debug, thiserror::Error)]
#[error("unknown import server")]
pub struct SelectionError;

impl ImportSelection {
    /// Validate every name before filtering; preserve source order and import once.
    pub fn select_servers(&self, servers: &mut McpServers) -> Result<(), SelectionError> {
        // Absence preserves the legacy all-items import; [] is an explicit opt-out.
        let Some(names) = &self.servers else {
            return Ok(());
        };
        let requested: BTreeSet<&str> = names.iter().map(String::as_str).collect();
        let available: BTreeSet<&str> = servers
            .servers
            .iter()
            .map(|server| server.name.as_str())
            .collect();
        if !requested.is_subset(&available) {
            return Err(SelectionError);
        }
        servers
            .servers
            .retain(|server| requested.contains(server.name.as_str()));
        Ok(())
    }
}
