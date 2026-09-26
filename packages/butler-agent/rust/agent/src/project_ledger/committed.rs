use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::ProjectLedgerReadError;

pub(super) type ReadSet = Vec<(String, Option<String>)>;

/// Observe one admitted target through the same committed-publication view.
pub(super) fn read_selected(
    root: &Path,
    relative: &str,
) -> Result<Option<String>, ProjectLedgerReadError> {
    for _attempt in 0..3 {
        let version = publication_version(root)?;
        let attempt = (|| {
            let claim = parse_optional(read_optional(&claim_path(root))?.as_deref())?;
            let journal = claim
                .as_ref()
                .and_then(|value| value.get("journalPath"))
                .and_then(Value::as_str)
                .map(|path| read_optional(Path::new(path)))
                .transpose()?
                .flatten();
            let journal = parse_optional(journal.as_deref())?;
            let first = selected(root, relative, journal.as_ref())?;
            if version == publication_version(root)? {
                let second = selected(root, relative, journal.as_ref())?;
                if first == second && version == publication_version(root)? {
                    return Ok(Some(first));
                }
            }
            Ok(None)
        })();
        match attempt {
            Ok(Some(raw)) => return Ok(raw),
            Err(error) if version == publication_version(root)? => return Err(error),
            Ok(None) | Err(_) => {}
        }
    }
    Err(ProjectLedgerReadError::RecordShow(
        "project_ledger_changed_during_record_read",
    ))
}

fn selected(
    root: &Path,
    relative: &str,
    journal: Option<&Value>,
) -> Result<Option<String>, ProjectLedgerReadError> {
    let before = journal.filter(|value| {
        value
            .get("base")
            .and_then(|base| base.get("recordPaths"))
            .and_then(Value::as_array)
            .is_some_and(|paths| paths.iter().any(|value| value.as_str() == Some(relative)))
            && matches!(
                value.get("status").and_then(Value::as_str),
                Some("committing" | "promoted" | "observed")
            )
    });
    let source_root = if let Some(journal) = before {
        let candidate = journal.get("candidateRoot").and_then(Value::as_str).ok_or(
            ProjectLedgerReadError::RecordShow("invalid_publication_journal"),
        )?;
        PathBuf::from(format!("{candidate}.before"))
    } else {
        root.to_path_buf()
    };
    read_optional(&record_path(&source_root, relative)?)
}

pub(super) fn read_all(root: &Path) -> Result<ReadSet, ProjectLedgerReadError> {
    read_all_with_hook(root, || {})
}

pub(super) fn read_all_with_hook(
    root: &Path,
    mut after_first_read: impl FnMut(),
) -> Result<ReadSet, ProjectLedgerReadError> {
    for _attempt in 0..3 {
        let version = publication_version(root)?;
        let attempt = (|| {
            let claim_text = read_optional(&claim_path(root))?;
            let claim = parse_optional(claim_text.as_deref())?;
            let journal_text = claim
                .as_ref()
                .and_then(|value| value.get("journalPath"))
                .and_then(Value::as_str)
                .map(|path| read_optional(Path::new(path)))
                .transpose()?
                .flatten();
            let journal = parse_optional(journal_text.as_deref())?;
            let first = read_set(root, journal.as_ref())?;
            after_first_read();
            if version == publication_version(root)? {
                let second = read_set(root, journal.as_ref())?;
                if first == second && version == publication_version(root)? {
                    return Ok(Some(first));
                }
            }
            Ok(None)
        })();
        match attempt {
            Ok(Some(records)) => return Ok(records),
            Err(error) if version == publication_version(root)? => return Err(error),
            Ok(None) | Err(_) => {}
        }
    }
    Err(ProjectLedgerReadError::RecordShow(
        "project_ledger_changed_during_record_read",
    ))
}

fn read_set(root: &Path, journal: Option<&Value>) -> Result<ReadSet, ProjectLedgerReadError> {
    let before = journal.filter(|value| {
        value
            .get("base")
            .and_then(|base| base.get("recordPaths"))
            .is_some()
            && matches!(
                value.get("status").and_then(Value::as_str),
                Some("committing" | "promoted" | "observed")
            )
    });
    record_files(root)?
        .into_iter()
        .map(|path| {
            let relative = path
                .strip_prefix(root)
                .map_err(|_| ProjectLedgerReadError::RecordShow("invalid_publication_record_path"))?
                .to_string_lossy()
                .to_string();
            let in_base = before
                .and_then(|value| value.get("base"))
                .and_then(|base| base.get("recordPaths"))
                .and_then(Value::as_array)
                .is_some_and(|paths| paths.iter().any(|value| value.as_str() == Some(&relative)));
            let source_root = if in_base {
                let candidate = before
                    .and_then(|value| value.get("candidateRoot"))
                    .and_then(Value::as_str)
                    .ok_or(ProjectLedgerReadError::RecordShow(
                        "invalid_publication_journal",
                    ))?;
                PathBuf::from(format!("{candidate}.before"))
            } else {
                root.to_path_buf()
            };
            let source = record_path(&source_root, &relative)?;
            Ok((relative, read_optional(&source)?))
        })
        .collect()
}

pub(super) fn record_files(root: &Path) -> Result<Vec<PathBuf>, ProjectLedgerReadError> {
    let project = root.join("project.json");
    let mut entries = Vec::new();
    list_files(root, &mut entries)?;
    entries.retain(|path| {
        path != &project
            && !path.ends_with("ledger.jsonl")
            && !matches!(
                path.file_name().and_then(|name| name.to_str()),
                Some(".DS_Store" | "github-issues.json")
            )
    });
    let mut files = Vec::with_capacity(entries.len() + 1);
    files.push(project);
    files.extend(entries);
    files.retain(|path| path.exists());
    Ok(files)
}

fn list_files(root: &Path, files: &mut Vec<PathBuf>) -> Result<(), ProjectLedgerReadError> {
    if !root.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(root).map_err(record_io)? {
        let entry = entry.map_err(record_io)?;
        let path = entry.path();
        let stat = fs::metadata(&path).map_err(record_io)?;
        if stat.is_dir() {
            if !matches!(entry.file_name().to_str(), Some("index" | "views")) {
                list_files(&path, files)?;
            }
        } else if stat.is_file() {
            files.push(path);
        }
    }
    Ok(())
}

pub(super) fn publication_version(root: &Path) -> Result<String, ProjectLedgerReadError> {
    let Some(claim) = read_optional(&claim_path(root))? else {
        return Ok(String::new());
    };
    let value: Value = serde_json::from_str(&claim)
        .map_err(|_| ProjectLedgerReadError::RecordShow("invalid_publication_claim"))?;
    let mut version = claim;
    if let Some(journal) = value.get("journalPath").and_then(Value::as_str) {
        version.push_str(&read_optional(Path::new(journal))?.unwrap_or_default());
    }
    Ok(version)
}

fn parse_optional(raw: Option<&str>) -> Result<Option<Value>, ProjectLedgerReadError> {
    raw.map(|value| {
        serde_json::from_str(value)
            .map_err(|_| ProjectLedgerReadError::RecordShow("invalid_publication_journal"))
    })
    .transpose()
}

fn claim_path(root: &Path) -> PathBuf {
    root.parent()
        .unwrap_or(root)
        .join(".project-ledger-locks")
        .join(format!(
            "{}.lock",
            root.file_name().unwrap_or_default().to_string_lossy()
        ))
}

fn record_path(root: &Path, relative: &str) -> Result<PathBuf, ProjectLedgerReadError> {
    if relative.is_empty() || relative.starts_with("..") || Path::new(relative).is_absolute() {
        return Err(ProjectLedgerReadError::RecordShow(
            "invalid_publication_record_path",
        ));
    }
    let mut cursor = root.to_path_buf();
    for component in Path::new(relative).components() {
        cursor.push(component);
        if cursor.exists()
            && fs::symlink_metadata(&cursor)
                .map_err(record_io)?
                .file_type()
                .is_symlink()
        {
            return Err(ProjectLedgerReadError::RecordShow(
                "publication_record_is_symlink",
            ));
        }
    }
    Ok(cursor)
}

fn read_optional(path: &Path) -> Result<Option<String>, ProjectLedgerReadError> {
    match fs::read(path) {
        Ok(raw) => Ok(Some(String::from_utf8_lossy(&raw).into_owned())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(record_io(error)),
    }
}

fn record_io(_error: std::io::Error) -> ProjectLedgerReadError {
    ProjectLedgerReadError::RecordShow("project_ledger_record_io_error")
}
