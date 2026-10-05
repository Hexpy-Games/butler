//! Small scoped rule inventory. Legacy listing is read-only and preserves text.
use super::*;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, path::Path};

/// Active row for the future authenticated settings adapter.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RememberedRule {
    /// Opaque stable handle.
    pub handle: String,
    /// Complete rule text.
    pub text: String,
    /// None means All chats; otherwise exactly one project.
    pub project_id: Option<String>,
    /// Revision required for targeted deletion.
    pub revision: String,
    /// Lifetime; absent means always for existing instructions.
    #[serde(default)]
    pub duration: Option<String>,
    /// Fixed UTC expiry, absent for lasting instructions.
    #[serde(default)]
    pub expires_at: Option<String>,
    /// Session ownership, independent of origin provenance.
    #[serde(default)]
    pub scope_session_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct Entry {
    pub handle: String,
    pub record_id: String,
    pub revision: String,
    /// Lifetime; absent means always for existing instructions.
    #[serde(default)]
    pub duration: Option<String>,
    /// Fixed UTC expiry, absent for lasting instructions.
    #[serde(default)]
    pub expires_at: Option<String>,
    /// Session ownership, independent of origin provenance.
    #[serde(default)]
    pub scope_session_id: Option<String>,

    pub content_hash: String,
    pub project_id: Option<String>,
    pub state: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub(super) struct Inventory {
    // Only active rows are read by prompts. Handle reservations are targeted files.
    pub scopes: BTreeMap<String, BTreeMap<String, Entry>>,
}

impl Inventory {
    pub(super) fn read(root: &Path) -> CognitionResult<Self> {
        if let Some(inventory) = read_json(&root.join("manifest.json"))? {
            return Ok(inventory);
        }
        let mut inventory = Self::default();
        let index = match fs::read_to_string(root.join("INDEX.md")) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(inventory),
            Err(error) => return Err(failure_source(error)),
        };
        for line in index.lines() {
            let Some((_, tail)) = line.split_once("](") else {
                continue;
            };
            let Some(file) = tail.strip_suffix(')') else {
                continue;
            };
            let Some(id) = file.strip_suffix(".md") else {
                continue;
            };
            super::super::write::validate_record_id(id)?;
            let text = fs::read_to_string(root.join(file)).map_err(failure_source)?;
            let binding = read_binding(
                root.parent().ok_or_else(|| failure("invalid_rule_root"))?,
                id,
            )?;
            let handle = inventory.allocate(root, id)?;
            inventory.put(Entry {
                handle,
                content_hash: binding
                    .as_ref()
                    .map(|b| b.content_hash.clone())
                    .unwrap_or_else(|| sha256(text.as_bytes())),
                record_id: id.into(),
                revision: binding
                    .as_ref()
                    .map(|b| b.revision.clone())
                    .unwrap_or_else(|| sha256(text.as_bytes())),
                project_id: binding.as_ref().and_then(|b| b.project_id.clone()),
                duration: None,
                expires_at: None,
                scope_session_id: None,
                state: binding.map(|b| b.state).unwrap_or_else(|| "active".into()),
            });
        }
        Ok(inventory)
    }

    pub(super) fn allocate(&self, root: &Path, id: &str) -> CognitionResult<String> {
        // Stable for read-only legacy rows; collision checking also includes tombstones.
        let digest = sha256(format!("rule-handle:{id}").as_bytes()).to_uppercase();
        for length in (10..=64).step_by(2) {
            let handle = format!("R{}", &digest[..length]);
            let reserved: Option<Entry> =
                read_json(&root.join("handles").join(format!("{handle}.json")))?;
            if self
                .find(&handle)
                .or(reserved.as_ref())
                .is_none_or(|row| row.record_id == id)
            {
                return Ok(handle);
            }
        }
        Err(failure("rule_handle_collision"))
    }

    pub(super) fn find(&self, handle: &str) -> Option<&Entry> {
        self.scopes.values().find_map(|scope| scope.get(handle))
    }

    pub(super) fn put(&mut self, row: Entry) {
        let rows = self
            .scopes
            .entry(scope(row.project_id.as_deref()))
            .or_default();
        if row.state == "active" {
            rows.insert(row.handle.clone(), row);
        } else {
            rows.remove(&row.handle);
        }
    }
}

fn scope(project: Option<&str>) -> String {
    project
        .map(|id| format!("project:{id}"))
        .unwrap_or_else(|| "global".into())
}

/// Read all active rules, or globals plus one project's rules, without adoption writes.
/// `project` is None for the settings inventory; Some(None) selects a general chat.
pub fn list_remembered_rules(
    rules_root: &Path,
    project: Option<Option<&str>>,
) -> CognitionResult<Vec<RememberedRule>> {
    list_rules(rules_root, project, None)
}

/// Read only the current chat's complete instruction text, including global/project scope.
pub fn list_chat_instructions(
    rules_root: &Path,
    project: Option<&str>,
    session: &str,
) -> CognitionResult<Vec<RememberedRule>> {
    list_rules(rules_root, Some(project), Some(session))
}

fn list_rules(
    rules_root: &Path,
    project: Option<Option<&str>>,
    session: Option<&str>,
) -> CognitionResult<Vec<RememberedRule>> {
    let pending: Option<super::transaction::Intent> = read_json(&rules_root.join("pending.json"))?;
    let inventory = Inventory::read(rules_root)?;
    let mut result = Vec::new();
    for (binding, rows) in &inventory.scopes {
        if project.is_some_and(|p| binding != "global" && *binding != scope(p)) {
            continue;
        }
        for row in rows.values() {
            if row.state != "active"
                || row
                    .scope_session_id
                    .as_deref()
                    .is_some_and(|id| session.is_some_and(|current| current != id))
                || pending
                    .as_ref()
                    .is_some_and(|p| p.entry.record_id == row.record_id)
            {
                continue;
            }
            let text = fs::read_to_string(rules_root.join(format!("{}.md", row.record_id)))
                .map_err(failure_source)?;
            if sha256(text.as_bytes()) != row.content_hash {
                continue;
            }
            result.push(RememberedRule {
                handle: row.handle.clone(),
                text,
                project_id: row.project_id.clone(),
                revision: row.revision.clone(),
                duration: row.duration.clone(),
                expires_at: row.expires_at.clone(),
                scope_session_id: row.scope_session_id.clone(),
            });
        }
    }
    pending_snapshot(pending, &mut result)?;
    let pending: Option<super::transaction::Intent> = read_json(&rules_root.join("pending.json"))?;
    pending_snapshot(pending, &mut result)?;
    let mut result = super::journal::overlay(rules_root, result)?;
    result.retain(|row| {
        project.is_none_or(|p| row.project_id.is_none() || row.project_id.as_deref() == p)
            && row
                .scope_session_id
                .as_deref()
                .is_none_or(|id| session.is_none_or(|current| current == id))
    });
    Ok(result)
}

/// A durable intent owns complete text through the receipt/manifest handoff.
/// A completed capture no longer overlays it, but must not hide its active row.
fn pending_snapshot(
    pending: Option<super::transaction::Intent>,
    rows: &mut Vec<RememberedRule>,
) -> CognitionResult<()> {
    let Some(pending) = pending else {
        return Ok(());
    };
    let entry = pending.entry;
    rows.retain(|row| row.handle != entry.handle);
    if entry.state == "active" {
        if sha256(pending.text.as_bytes()) != entry.content_hash {
            return Err(failure("rule_pending_content_mismatch"));
        }
        rows.push(RememberedRule {
            handle: entry.handle,
            text: pending.text,
            project_id: entry.project_id,
            revision: entry.revision,
            duration: entry.duration,
            expires_at: entry.expires_at,
            scope_session_id: entry.scope_session_id,
        });
    }
    Ok(())
}

pub(super) fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> CognitionResult<Option<T>> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(failure_source),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(failure_source(error)),
    }
}

pub(super) fn write_json(path: &Path, value: &impl Serialize) -> CognitionResult<()> {
    let bytes = serde_json::to_vec_pretty(value).map_err(failure_source)?;
    super::super::write::write_atomic(path, &bytes)
}
