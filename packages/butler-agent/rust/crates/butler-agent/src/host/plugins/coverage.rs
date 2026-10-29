//! Consent coverage over normalized templates, independent of package content.
use super::types::*;
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path};

pub(super) fn uncovered(
    approved: &CapabilitySet,
    next: &CapabilitySet,
    old_hashes: &BTreeMap<String, String>,
    hashes: &BTreeMap<String, String>,
) -> Vec<Value> {
    let mut growth = Vec::new();
    for item in &next.runs_on_this_computer {
        if !approved
            .runs_on_this_computer
            .iter()
            .any(|old| executable(&old.argv) == executable(&item.argv))
        {
            growth.push(json!({"kind":"executable","item":item,"new":true}));
        }
    }
    for item in &next.network {
        if !approved.network.contains(item) {
            growth.push(json!({"kind":"network","item":item,"new":true}));
        }
    }
    for item in &next.files {
        if !approved.files.iter().any(|old| file_covers(old, item)) {
            growth.push(json!({"kind":"files","item":item,"new":true}));
        }
    }
    for item in &next.agent_tools {
        if !approved.agent_tools.contains(item) {
            growth.push(json!({"kind":"mcp_server","item":item,"new":true}));
        }
    }
    for item in &next.secrets {
        if !approved.secrets.iter().any(|old| old.key == item.key) {
            growth.push(json!({"kind":"secret","item":item,"new":true}));
        }
    }
    for item in &next.hooks {
        if !approved.hooks.contains(item)
            || item
                .argv
                .iter()
                .filter_map(|arg| arg.strip_prefix("${BUTLER_PLUGIN_ROOT}/"))
                .any(|path| old_hashes.get(path) != hashes.get(path))
        {
            growth.push(json!({"kind":"hook","item":item,"new":true}));
        }
    }
    for (id, item) in &next.connectors {
        if !approved
            .connectors
            .get(id)
            .is_some_and(|old| super::connector_manifest::covers(old, item))
        {
            growth.push(json!({"kind":"connector","item":item,"new":true}));
        }
    }
    growth
}
fn executable(argv: &[String]) -> Vec<String> {
    let mut argv = argv.to_vec();
    if let Some(command) = argv.first_mut() {
        if let Some(path) = command.strip_prefix("${BUTLER_PLUGIN_ROOT}/") {
            *command = format!("plugin:{path}");
        } else {
            *command = command
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or(command)
                .to_owned();
        }
    }
    argv
}
fn file_covers(old: &FileScope, next: &FileScope) -> bool {
    Path::new(&next.path).starts_with(&old.path)
        && (old.access == next.access || old.access == "read_write")
}
pub(super) fn hook_hashes(i: &Inspection) -> BTreeMap<String, String> {
    i.files
        .iter()
        .filter(|f| {
            i.package.hooks.iter().any(|h| {
                h.args
                    .iter()
                    .flatten()
                    .any(|arg| arg == &format!("${{BUTLER_PLUGIN_ROOT}}/{}", f.path))
            })
        })
        .map(|f| (f.path.clone(), f.hash.clone()))
        .collect()
}
