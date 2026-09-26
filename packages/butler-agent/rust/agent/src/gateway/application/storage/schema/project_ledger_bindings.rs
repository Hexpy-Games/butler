//! Preserve existing project-to-ledger bindings during App schema initialization.
//!
//! Runs only on the App SQLite owner thread. Filesystem inspection determines
//! legacy identity; it never creates, moves, or modifies a ledger directory.

mod filesystem;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use rusqlite::{Connection, params};

use super::super::AppStorageError;
use filesystem::{Candidate, candidates, initialized_root, root_available, safe_id, trim};

struct Project {
    id: String,
    display_name: String,
    workspace_path: String,
    workspace_label: String,
    safe_path_label: String,
    ledger_project_id: Option<String>,
}

#[derive(Default)]
struct Assigned {
    bindings: HashSet<String>,
    roots: HashSet<PathBuf>,
    projects: HashSet<String>,
}

pub(super) fn initialize(
    connection: &Connection,
    butler_data: Option<&Path>,
) -> Result<(), AppStorageError> {
    let projects_root = butler_data
        .filter(|path| !trim(&path.to_string_lossy()).is_empty())
        .map(|path| filesystem::absolute(&path.join("project-ledger/projects")))
        .transpose()
        .map_err(filesystem_error)?;
    let rows = read_projects(connection)?;
    let mut assigned = Assigned::default();
    let mut initialized = HashMap::<&str, Vec<Candidate>>::new();
    let mut labels = HashMap::<String, usize>::new();
    let mut ids = HashMap::<String, Vec<&str>>::new();
    for row in &rows {
        *labels.entry(key(&row.safe_path_label)).or_default() += 1;
        ids.entry(key(&row.id)).or_default().push(&row.id);
        if let Some(existing) = row
            .ledger_project_id
            .as_deref()
            .map(trim)
            .filter(|id| !id.is_empty())
        {
            assigned.bindings.insert(key(existing));
            assigned.projects.insert(row.id.clone());
            if let Some(root) = projects_root
                .as_deref()
                .and_then(|root| initialized_root(root, existing))
            {
                assigned.roots.insert(root);
            }
        } else {
            initialized.insert(
                &row.id,
                candidates(row, projects_root.as_deref()).map_err(filesystem_error)?,
            );
        }
    }
    let mut root_counts = HashMap::<&Path, usize>::new();
    for candidate in initialized.values().flatten() {
        *root_counts.entry(&candidate.root).or_default() += 1;
    }
    let mut require_id_fallback = HashSet::new();
    for row in &rows {
        if assigned.projects.contains(&row.id) {
            continue;
        }
        let Some(candidates) = initialized
            .get(row.id.as_str())
            .filter(|values| !values.is_empty())
        else {
            continue;
        };
        if candidates.len() != 1 {
            require_id_fallback.insert(row.id.as_str());
            continue;
        }
        let candidate = &candidates[0];
        if root_counts.get(candidate.root.as_path()) != Some(&1)
            || assigned.bindings.contains(&key(&candidate.id))
            || assigned.roots.contains(&candidate.root)
        {
            require_id_fallback.insert(row.id.as_str());
            continue;
        }
        bind(
            connection,
            &mut assigned,
            row,
            &candidate.id,
            Some(&candidate.root),
        )?;
    }
    for (index, row) in rows.iter().enumerate() {
        if assigned.projects.contains(&row.id) {
            continue;
        }
        let legacy_key = key(&row.safe_path_label);
        let requires_fallback = require_id_fallback.contains(row.id.as_str());
        let legacy_is_safe = !requires_fallback
            && safe_id(&row.safe_path_label)
            && labels.get(&legacy_key) == Some(&1)
            && ids
                .get(&legacy_key)
                .is_none_or(|values| values.iter().all(|id| *id == row.id))
            && !assigned.bindings.contains(&legacy_key)
            && root_available(projects_root.as_deref(), &row.safe_path_label);
        let binding = if legacy_is_safe {
            row.safe_path_label.clone()
        } else {
            let forbidden = initialized
                .get(row.id.as_str())
                .into_iter()
                .flatten()
                .filter(|_| requires_fallback)
                .map(|candidate| key(&candidate.id))
                .collect();
            unique_id(
                &row.id,
                index,
                &assigned.bindings,
                &forbidden,
                projects_root.as_deref(),
            )
        };
        bind(connection, &mut assigned, row, &binding, None)?;
    }
    Ok(())
}

fn read_projects(connection: &Connection) -> Result<Vec<Project>, AppStorageError> {
    let mut query = connection.prepare(
        "SELECT id,display_name,workspace_path,workspace_label,safe_path_label,ledger_project_id \
         FROM projects ORDER BY id COLLATE BINARY",
    ).map_err(AppStorageError::sqlite)?;
    query
        .query_map([], |row| {
            Ok(Project {
                id: row.get(0)?,
                display_name: row.get(1)?,
                workspace_path: row.get(2)?,
                workspace_label: row.get(3)?,
                safe_path_label: row.get(4)?,
                ledger_project_id: row.get(5)?,
            })
        })
        .map_err(AppStorageError::sqlite)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(AppStorageError::sqlite)
}

fn bind(
    connection: &Connection,
    assigned: &mut Assigned,
    row: &Project,
    binding: &str,
    physical_root: Option<&Path>,
) -> Result<(), AppStorageError> {
    connection
        .execute(
            "UPDATE projects SET ledger_project_id=?1 WHERE id=?2 \
         AND (ledger_project_id IS NULL OR trim(ledger_project_id)='')",
            params![binding, row.id],
        )
        .map_err(AppStorageError::sqlite)?;
    assigned.bindings.insert(key(binding));
    assigned.projects.insert(row.id.clone());
    if let Some(root) = physical_root {
        assigned.roots.insert(root.to_path_buf());
    }
    Ok(())
}

fn unique_id(
    project_id: &str,
    row_index: usize,
    assigned: &HashSet<String>,
    forbidden: &HashSet<String>,
    projects_root: Option<&Path>,
) -> String {
    let base = if safe_id(project_id) {
        project_id.to_owned()
    } else {
        format!("project-ledger-{}", row_index + 1)
    };
    let available = |candidate: &str| {
        !assigned.contains(&key(candidate))
            && !forbidden.contains(&key(candidate))
            && root_available(projects_root, candidate)
    };
    if available(&base) {
        return base;
    }
    for index in 2_u64.. {
        let suffix = format!("-ledger-{index}");
        let candidate = format!("{}{}", &base[..base.len().min(120 - suffix.len())], suffix);
        if available(&candidate) {
            return candidate;
        }
    }
    unreachable!("all u64 ledger suffixes cannot exist in a finite directory")
}

fn key(value: &str) -> String {
    value.to_lowercase()
}

#[cfg(test)]
mod tests;

fn filesystem_error(error: std::io::Error) -> AppStorageError {
    AppStorageError::new(
        "app_project_ledger_path_resolution_failed",
        error.to_string(),
    )
}
