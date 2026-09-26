use std::fs;
use std::path::Path;

use crate::locale::LocaleCollation;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::{
    DashboardLedgerSnapshot, DashboardLedgerSource, DashboardWorkHistoryEntry,
    ProjectLedgerBinding, managed,
};
use crate::project_ledger::{ProjectLedgerReadError, records};

pub(super) fn read_reference(
    root: &Path,
    binding: &ProjectLedgerBinding,
    snapshot: &DashboardLedgerSnapshot,
    id: &str,
    expected_revision: &str,
    collation: &LocaleCollation,
) -> Result<DashboardLedgerSource, ProjectLedgerReadError> {
    let (work_id, _) = id
        .split_once('|')
        .ok_or(ProjectLedgerReadError::DashboardUnavailable(
            "dashboard_source_unavailable",
        ))?;
    let entry = list(root, binding, snapshot, Some(work_id), collation)
        .map_err(|_| ProjectLedgerReadError::DashboardInternal("dashboard_history_unavailable"))?
        .into_iter()
        .find(|entry| entry.id == id)
        .ok_or(ProjectLedgerReadError::DashboardUnavailable(
            "dashboard_source_unavailable",
        ))?;
    if entry.revision != expected_revision {
        return Err(ProjectLedgerReadError::DashboardChanged);
    }
    Ok(DashboardLedgerSource {
        title: entry.title,
        body: format!("```json\n{}\n```", entry.body),
        revision: entry.revision,
        document_type: "reference".into(),
        updated_at: entry.at,
        status: entry.status,
    })
}

pub(super) fn list(
    root: &Path,
    binding: &ProjectLedgerBinding,
    snapshot: &DashboardLedgerSnapshot,
    work_id: Option<&str>,
    collation: &LocaleCollation,
) -> Result<Vec<DashboardWorkHistoryEntry>, ProjectLedgerReadError> {
    let directory = root.join("references");
    let entries = match fs::symlink_metadata(&directory) {
        Ok(stat) if stat.file_type().is_symlink() => return Err(unavailable()),
        Ok(_) => fs::read_dir(&directory).map_err(|_| unavailable())?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(unavailable()),
    };
    let mut projected = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|_| unavailable())?;
        if !entry.file_type().map_err(|_| unavailable())?.is_file()
            || !entry.file_name().to_string_lossy().ends_with(".md")
        {
            continue;
        }
        let stat = fs::symlink_metadata(entry.path()).map_err(|_| unavailable())?;
        if !stat.is_file() || stat.file_type().is_symlink() || stat.len() > 1_048_576 {
            continue;
        }
        let raw = fs::read_to_string(entry.path()).map_err(|_| unavailable())?;
        let Some(metadata) = records::frontmatter(&raw) else {
            continue;
        };
        let Some(owner) = metadata.get("parentId").and_then(Value::as_str) else {
            continue;
        };
        let Some(work) = snapshot.works.iter().find(|work| {
            work.record.id == owner
                && work.availability == "ready"
                && work.managed.is_some()
                && work_id.is_none_or(|requested| requested == owner)
        }) else {
            continue;
        };
        let body = records::frontmatter_body(&raw);
        let Ok(value) = serde_json::from_str::<Value>(&body) else {
            continue;
        };
        let schema = value.get("schema").and_then(Value::as_str).unwrap_or("");
        if !matches!(
            schema,
            "butler.btcc-project-work-review.v1"
                | "butler.btcc-project-work-disposition.v1"
                | "butler.btcc-project-work-result-reference.v1"
        ) {
            continue;
        }
        let child_id = metadata
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(unavailable)?;
        let child = managed::read_history_child(root, binding, owner, child_id, schema, collation)?;
        let (at, action, status, projection) = public_child(&child)?;
        let body = serde_json::to_string_pretty(&projection).map_err(|_| unavailable())?;
        let revision = format!(
            "{:x}",
            Sha256::digest(format!("{owner}\0{child_id}\0{body}").as_bytes())
        );
        let managed = work.managed.as_ref().ok_or_else(unavailable)?;
        projected.push(DashboardWorkHistoryEntry {
            id: format!("{owner}|{child_id}"),
            work_id: owner.into(),
            session_id: managed.session_id.clone(),
            at,
            action,
            title: managed.objective.clone(),
            body,
            revision,
            status,
        });
    }
    Ok(projected)
}

fn public_child(value: &Value) -> Result<(String, String, String, Value), ProjectLedgerReadError> {
    let schema = value
        .get("schema")
        .and_then(Value::as_str)
        .ok_or_else(unavailable)?;
    let (parent, keys, at, status, action) = match schema {
        "butler.btcc-project-work-review.v1" => (
            "review",
            &["subject", "verdict", "summary", "corrections"][..],
            "createdAt",
            "verdict",
            "reviewed",
        ),
        "butler.btcc-project-work-disposition.v1" => (
            "disposition",
            &[
                "disposition",
                "summary",
                "remainingActions",
                "nextCondition",
                "followups",
            ][..],
            "createdAt",
            "disposition",
            "disposition",
        ),
        "butler.btcc-project-work-result-reference.v1" => (
            "result",
            &["toolName", "status", "attachedAt"][..],
            "attachedAt",
            "status",
            "result",
        ),
        _ => return Err(unavailable()),
    };
    let source = value
        .get(parent)
        .and_then(Value::as_object)
        .ok_or_else(unavailable)?;
    let at = source
        .get(at)
        .and_then(Value::as_str)
        .ok_or_else(unavailable)?
        .to_owned();
    let status = source
        .get(status)
        .and_then(Value::as_str)
        .ok_or_else(unavailable)?
        .to_owned();
    let mut projection = Map::new();
    for key in keys {
        if let Some(value) = source.get(*key) {
            let output_key = if *key == "attachedAt" {
                "recordedAt"
            } else {
                key
            };
            projection.insert(output_key.into(), value.clone());
        }
    }
    Ok((at, action.into(), status, Value::Object(projection)))
}

fn unavailable() -> ProjectLedgerReadError {
    ProjectLedgerReadError::RecordShow("dashboard_source_unavailable")
}
