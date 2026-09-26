//! Source Ledger semantic/storage fingerprints for stable legacy reads.

use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

use super::{ProjectLedgerReadError, committed, records};
use crate::{json as js, locale::LocaleCollation};

pub(super) struct SourceHead {
    pub project_root: PathBuf,
    pub source_sha256: String,
    pub source_file_count: usize,
    pub storage_sha256: String,
    pub storage_entry_count: usize,
}

pub(super) fn observe(
    root: &Path,
    collation: &LocaleCollation,
) -> Result<SourceHead, ProjectLedgerReadError> {
    let mut descriptors = Vec::new();
    for path in committed::record_files(root)? {
        let (_, metadata) = record_data(&path)?;
        let kind = record_kind(root, &path, &metadata);
        let id = metadata
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("project");
        descriptors.push((format!("{kind}\0{id}"), path));
    }
    descriptors.sort_by(|left, right| collation.compare(&left.0, &right.0));
    let mut semantic = Sha256::new();
    semantic.update(b"[");
    for (index, (_, path)) in descriptors.iter().enumerate() {
        let (raw, data) = record_data(path)?;
        let kind = record_kind(root, path, &data);
        let id = data.get("id").and_then(Value::as_str).unwrap_or("project");
        let metadata = data
            .as_object()
            .map(|object| {
                object
                    .iter()
                    .filter(|(key, _)| {
                        !matches!(
                            key.as_str(),
                            "createdAt"
                                | "updatedAt"
                                | "generatedAt"
                                | "sourceMtimeMs"
                                | "path"
                                | "codeCommits"
                                | "ledgerCommits"
                        )
                    })
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect::<Map<_, _>>()
            })
            .unwrap_or_default();
        let mut record = json!({"kind":kind,"id":id,"metadata":metadata});
        if path.extension().and_then(|v| v.to_str()) == Some("md") {
            record["body"] = records::frontmatter_body_ref(&raw).into();
        }
        let normalized = normalize(&record);
        let mut encoded = String::new();
        write_canonical(&normalized, collation, &mut encoded)?;
        if index != 0 {
            semantic.update(b",");
        }
        semantic.update(encoded.as_bytes());
    }
    semantic.update(b"]");
    let mut entries = Vec::new();
    root_entries(root, root, &mut entries)?;
    entries.sort_by(|left, right| collation.compare(&left.0, &right.0));
    let mut storage = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    for (relative, path, directory) in &entries {
        storage.update(if *directory {
            b"directory".as_slice()
        } else {
            b"file".as_slice()
        });
        storage.update(b"\0");
        storage.update(relative.nfc().collect::<String>().as_bytes());
        storage.update(b"\0");
        if !directory {
            let mut file = File::open(path).map_err(io)?;
            loop {
                let size = file.read(&mut buffer).map_err(io)?;
                if size == 0 {
                    break;
                }
                storage.update(&buffer[..size]);
            }
        }
        storage.update(b"\0");
    }
    Ok(SourceHead {
        project_root: root.to_owned(),
        source_sha256: format!("{:x}", semantic.finalize()),
        source_file_count: descriptors.len(),
        storage_sha256: format!("{:x}", storage.finalize()),
        storage_entry_count: entries.len(),
    })
}

fn record_data(path: &Path) -> Result<(String, Value), ProjectLedgerReadError> {
    let bytes = fs::read(path).map_err(io)?;
    let raw = String::from_utf8_lossy(&bytes).into_owned();
    let metadata = match path.extension().and_then(|value| value.to_str()) {
        Some("json") => serde_json::from_str(&raw).map_err(|_| invalid())?,
        Some("md") => records::frontmatter(&raw).unwrap_or_else(|| json!({})),
        _ => json!({}),
    };
    Ok((raw, metadata))
}

fn record_kind<'a>(root: &Path, path: &Path, metadata: &'a Value) -> &'a str {
    metadata
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or(if path == root.join("project.json") {
            "project"
        } else {
            "record"
        })
}

// Source-head JSON permits arbitrary record metadata; strict Work codec limits
// do not apply here. NFC key collisions follow Object.fromEntries last-write.
fn write_canonical(
    value: &Value,
    collation: &LocaleCollation,
    out: &mut String,
) -> Result<(), ProjectLedgerReadError> {
    match value {
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index != 0 {
                    out.push(',');
                }
                write_canonical(item, collation, out)?;
            }
            out.push(']');
        }
        Value::Object(items) => {
            let mut entries = items.iter().collect::<Vec<_>>();
            entries.sort_by(|a, b| collation.compare(a.0, b.0));
            out.push('{');
            for (index, (key, value)) in entries.into_iter().enumerate() {
                if index != 0 {
                    out.push(',');
                }
                out.push_str(&js::stringify(&Value::String(key.clone())).map_err(|_| invalid())?);
                out.push(':');
                write_canonical(value, collation, out)?;
            }
            out.push('}');
        }
        scalar => out.push_str(&js::stringify(scalar).map_err(|_| invalid())?),
    }
    Ok(())
}

fn normalize(value: &Value) -> Value {
    match value {
        Value::String(text) => Value::String(text.nfc().collect()),
        Value::Array(items) => Value::Array(items.iter().map(normalize).collect()),
        Value::Object(items) => Value::Object(
            items
                .iter()
                .map(|(key, value)| (key.nfc().collect(), normalize(value)))
                .collect(),
        ),
        value => value.clone(),
    }
}

fn root_entries(
    root: &Path,
    directory: &Path,
    entries: &mut Vec<(String, PathBuf, bool)>,
) -> Result<(), ProjectLedgerReadError> {
    for entry in fs::read_dir(directory).map_err(io)? {
        let entry = entry.map_err(io)?;
        if matches!(
            entry.file_name().to_str(),
            Some(".DS_Store" | "github-issues.json")
        ) {
            continue;
        }
        let path = entry.path();
        let kind = entry.file_type().map_err(io)?;
        if !kind.is_dir() && !kind.is_file() {
            return Err(invalid());
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| invalid())?
            .to_string_lossy()
            .replace('\\', "/");
        entries.push((relative, path.clone(), kind.is_dir()));
        if kind.is_dir() {
            root_entries(root, &path, entries)?;
        }
    }
    Ok(())
}

fn invalid() -> ProjectLedgerReadError {
    ProjectLedgerReadError::RecordShow("project_ledger_source_head_invalid")
}
fn io(_: std::io::Error) -> ProjectLedgerReadError {
    ProjectLedgerReadError::RecordShow("project_ledger_source_head_io_error")
}
