use std::fs;
use std::path::Path;

use butler_core::locale::LocaleCollation;
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
        .ok_or(ProjectLedgerReadError::dashboard_unavailable(
            "dashboard_source_unavailable",
        ))?;
    let entry = list(root, binding, snapshot, Some(work_id), collation)
        .map_err(|source| {
            ProjectLedgerReadError::dashboard_internal("dashboard_history_unavailable")
                .with_source(source)
        })?
        .into_iter()
        .find(|entry| entry.id == id)
        .ok_or(ProjectLedgerReadError::dashboard_unavailable(
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

/// The public history of managed Work: every review, disposition and result
/// reference child of a ready managed Work (or only `work_id`'s).
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
        Ok(_) => fs::read_dir(&directory).map_err(|source| unavailable().with_source(source))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(unavailable()),
    };
    let history = History {
        root,
        binding,
        snapshot,
        work_id,
        collation,
    };
    let mut projected = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|source| unavailable().with_source(source))?;
        let Some(raw) = reference_file(&entry)? else {
            continue;
        };
        if let Some(item) = history.entry(&raw)? {
            projected.push(item);
        }
    }
    Ok(projected)
}

/// A regular `.md` reference of at most 1 MiB, read.
fn reference_file(entry: &fs::DirEntry) -> Result<Option<String>, ProjectLedgerReadError> {
    let is_file = entry
        .file_type()
        .map_err(|source| unavailable().with_source(source))?
        .is_file();
    if !is_file || !entry.file_name().to_string_lossy().ends_with(".md") {
        return Ok(None);
    }
    let stat =
        fs::symlink_metadata(entry.path()).map_err(|source| unavailable().with_source(source))?;
    if !stat.is_file() || stat.file_type().is_symlink() || stat.len() > 1_048_576 {
        return Ok(None);
    }
    fs::read_to_string(entry.path())
        .map(Some)
        .map_err(|source| unavailable().with_source(source))
}

struct History<'a> {
    root: &'a Path,
    binding: &'a ProjectLedgerBinding,
    snapshot: &'a DashboardLedgerSnapshot,
    work_id: Option<&'a str>,
    collation: &'a LocaleCollation,
}

impl History<'_> {
    /// The history entry of one reference file, when it is a public child
    /// of a listed Work.
    fn entry(
        &self,
        raw: &str,
    ) -> Result<Option<DashboardWorkHistoryEntry>, ProjectLedgerReadError> {
        let Some(metadata) = records::frontmatter(raw) else {
            return Ok(None);
        };
        let Some(owner) = metadata.get("parentId").and_then(Value::as_str) else {
            return Ok(None);
        };
        let Some(work) = self.snapshot.works.iter().find(|work| {
            work.record.id == owner
                && work.availability == "ready"
                && work.managed.is_some()
                && self.work_id.is_none_or(|requested| requested == owner)
        }) else {
            return Ok(None);
        };
        let Ok(value) = serde_json::from_str::<Value>(&records::frontmatter_body(raw)) else {
            return Ok(None);
        };
        let Some(kind) = value
            .get("schema")
            .and_then(Value::as_str)
            .and_then(ChildKind::parse)
        else {
            return Ok(None);
        };
        let child_id = metadata
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(unavailable)?;
        let child = managed::read_history_child(
            self.root,
            self.binding,
            owner,
            child_id,
            kind.schema(),
            self.collation,
        )?;
        let (at, status, projection) = public_child(&child)?;
        let body = serde_json::to_string_pretty(&projection)
            .map_err(|source| unavailable().with_source(source))?;
        let revision = format!(
            "{:x}",
            Sha256::digest(format!("{owner}\0{child_id}\0{body}").as_bytes())
        );
        let managed = work.managed.as_ref().ok_or_else(unavailable)?;
        Ok(Some(DashboardWorkHistoryEntry {
            id: format!("{owner}|{child_id}"),
            work_id: owner.into(),
            session_id: managed.session_id.clone(),
            at,
            action: kind.action().into(),
            title: managed.objective.clone(),
            body,
            revision,
            status,
        }))
    }
}

/// A managed Work child the public history shows.
#[derive(Clone, Copy)]
enum ChildKind {
    Review,
    Disposition,
    Result,
}

impl ChildKind {
    fn parse(schema: &str) -> Option<Self> {
        match schema {
            "butler.btcc-project-work-review.v1" => Some(Self::Review),
            "butler.btcc-project-work-disposition.v1" => Some(Self::Disposition),
            "butler.btcc-project-work-result-reference.v1" => Some(Self::Result),
            _ => None,
        }
    }

    fn schema(self) -> &'static str {
        match self {
            Self::Review => "butler.btcc-project-work-review.v1",
            Self::Disposition => "butler.btcc-project-work-disposition.v1",
            Self::Result => "butler.btcc-project-work-result-reference.v1",
        }
    }

    fn action(self) -> &'static str {
        match self {
            Self::Review => "reviewed",
            Self::Disposition => "disposition",
            Self::Result => "result",
        }
    }

    /// The payload key, its public fields, and its time and status fields.
    fn fields(
        self,
    ) -> (
        &'static str,
        &'static [&'static str],
        &'static str,
        &'static str,
    ) {
        match self {
            Self::Review => (
                "review",
                &["subject", "verdict", "summary", "corrections"],
                "createdAt",
                "verdict",
            ),
            Self::Disposition => (
                "disposition",
                &[
                    "disposition",
                    "summary",
                    "remainingActions",
                    "nextCondition",
                    "followups",
                ],
                "createdAt",
                "disposition",
            ),
            Self::Result => (
                "result",
                &["toolName", "status", "attachedAt"],
                "attachedAt",
                "status",
            ),
        }
    }
}

/// The child's time, status and public projection.
fn public_child(value: &Value) -> Result<(String, String, Value), ProjectLedgerReadError> {
    let kind = value
        .get("schema")
        .and_then(Value::as_str)
        .and_then(ChildKind::parse)
        .ok_or_else(unavailable)?;
    let (parent, keys, at, status) = kind.fields();
    let source = value
        .get(parent)
        .and_then(Value::as_object)
        .ok_or_else(unavailable)?;
    let text = |key: &str| {
        source
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(unavailable)
    };
    let at = text(at)?;
    let status = text(status)?;
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
    Ok((at, status, Value::Object(projection)))
}

fn unavailable() -> ProjectLedgerReadError {
    ProjectLedgerReadError::record_show("dashboard_source_unavailable")
}
