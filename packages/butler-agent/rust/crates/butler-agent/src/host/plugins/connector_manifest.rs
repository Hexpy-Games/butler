use super::{Result, error, manifest::valid_id, types::Package};
use serde_json::Value;
use std::collections::BTreeSet;
pub(super) fn read(ext: Option<&Value>, package: &mut Package) -> Result<()> {
    let Some(value) = ext.and_then(|v| v.get("connectors")) else {
        return Ok(());
    };
    package.connectors =
        serde_json::from_value(value.clone()).map_err(|_| error("plugin_connector_invalid"))?;
    let mut ids = BTreeSet::new();
    for c in &package.connectors {
        if !valid_id(&c.id)
            || !ids.insert(&c.id)
            || c.label.is_empty()
            || package
                .servers
                .get(&c.events.server)
                .is_none_or(|s| s.transport != "stdio")
        {
            return Err(error("plugin_connector_invalid"));
        }
        for tool in std::iter::once(&c.context.tool).chain(c.actions.iter().map(|a| &a.tool)) {
            let (server, tool) = tool
                .split_once('/')
                .ok_or_else(|| error("plugin_connector_tool_invalid"))?;
            if tool.is_empty() || !package.servers.contains_key(server) {
                return Err(error("plugin_connector_tool_invalid"));
            }
        }
        let mut fields = BTreeSet::new();
        for field in c.account.fields.iter().chain(&c.account.secrets) {
            if field.key.is_empty()
                || !fields.insert(&field.key)
                || !field
                    .key
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_')
                || field.key.starts_with("BUTLER_")
                || field.key.starts_with("CLAUDE_")
            {
                return Err(error("plugin_connector_field_invalid"));
            }
        }
        if c.actions.iter().any(|a| a.destination)
            && c.destinations
                .as_ref()
                .is_none_or(|d| d.resource.is_empty() || d.argument.is_empty())
        {
            return Err(error("plugin_connector_destinations_invalid"));
        }
    }
    Ok(())
}
pub(super) fn covers(
    old: &butler_core::plugins::ConnectorDefinition,
    new: &butler_core::plugins::ConnectorDefinition,
) -> bool {
    old.events == new.events
        && old.context == new.context
        && old.destinations == new.destinations
        && new
            .account
            .secrets
            .iter()
            .all(|f| old.account.secrets.iter().any(|o| o.key == f.key))
        && new.actions.iter().all(|a| {
            old.actions.iter().any(|o| {
                o.tool == a.tool
                    && (!a.organize || o.organize)
                    && o.destination == a.destination
                    && o.relocates == a.relocates
            })
        })
}
