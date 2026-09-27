//! Bounded guided generated-artifact observation and declared publication.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

use crate::locale::LocaleCollation;

const MAX_FILES: usize = 20_000;
const MAX_DEPTH: usize = 8;
const MAX_ARTIFACTS: usize = 12;
const MAX_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
pub(super) struct Artifact {
    pub path: String,
    pub artifact_kind: &'static str,
    pub size_bytes: u64,
    pub modified_at: String,
}

#[derive(Default)]
pub(super) struct Snapshot(HashMap<String, String>);

pub(super) struct Publication {
    pub requested: usize,
    pub artifacts: Vec<Artifact>,
    pub error: Option<String>,
}

struct File {
    relative: String,
    path: PathBuf,
    fingerprint: String,
    size: u64,
    modified: std::time::SystemTime,
}

pub(super) fn snapshot(data: &Path) -> Snapshot {
    Snapshot(
        scan(data)
            .into_iter()
            .map(|file| (file.relative, file.fingerprint))
            .collect(),
    )
}

pub(super) fn publish(
    args: &serde_json::Map<String, Value>,
    data: &Path,
    workspace: &Path,
    cwd: &Path,
    before: Option<&Snapshot>,
    success: bool,
) -> Publication {
    let requested = args
        .get("output_paths")
        .and_then(Value::as_array)
        .map(|paths| {
            paths
                .iter()
                .filter_map(Value::as_str)
                .filter(|path| !crate::public_text::trim_js_whitespace(path).is_empty())
                .count()
        })
        .unwrap_or(0);
    if !success {
        return Publication {
            requested,
            artifacts: Vec::new(),
            error: None,
        };
    }
    if requested > 0 {
        return declared(args, data, workspace, cwd, requested);
    }
    let Some(before) = before else {
        return Publication {
            requested: 0,
            artifacts: Vec::new(),
            error: None,
        };
    };
    Publication {
        requested: 0,
        artifacts: scan(data)
            .into_iter()
            .filter(|file| file.size > 0 && before.0.get(&file.relative) != Some(&file.fingerprint))
            .take(MAX_ARTIFACTS)
            .map(|file| artifact(&file))
            .collect(),
        error: None,
    }
}

fn declared(
    args: &serde_json::Map<String, Value>,
    data: &Path,
    workspace: &Path,
    cwd: &Path,
    requested: usize,
) -> Publication {
    let generated = data.join("artifacts/generated");
    if fs::create_dir_all(&generated).is_err() {
        return Publication {
            requested: requested.min(24),
            artifacts: Vec::new(),
            error: None,
        };
    }
    let root = canonical(&generated);
    let data_root = canonical(data);
    if !root.starts_with(&data_root) {
        return Publication {
            requested: requested.min(24),
            artifacts: Vec::new(),
            error: None,
        };
    }
    let workspace_root = canonical(workspace);
    let mut artifacts = Vec::new();
    let mut seen = HashSet::new();
    for source in args
        .get("output_paths")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(crate::public_text::trim_js_whitespace)
        .filter(|path| !path.is_empty())
        .take(24)
    {
        let Some(candidate) = source_path(source, data, cwd, &root) else {
            continue;
        };
        let Some((real, bytes)) = verified_source(&candidate, &workspace_root, &root) else {
            continue;
        };
        let published = if real.starts_with(&root) {
            Some(real)
        } else {
            publish_file(&root, &real, &bytes)
        };
        let Some(published) = published else { continue };
        let published = canonical(&published);
        if !published.starts_with(&root) {
            continue;
        }
        let Ok(stat) = fs::symlink_metadata(&published) else {
            continue;
        };
        if !stat.is_file() || stat.file_type().is_symlink() || stat.len() == 0 {
            continue;
        }
        let Ok(relative) = published.strip_prefix(&root) else {
            continue;
        };
        let label = format!(
            "artifacts/generated/{}",
            relative.to_string_lossy().replace('\\', "/")
        );
        if seen.insert(label.clone()) {
            artifacts.push(Artifact {
                path: label,
                artifact_kind: kind(&published),
                size_bytes: stat.len(),
                modified_at: iso(stat.modified().unwrap_or(std::time::UNIX_EPOCH)),
            });
        }
        if artifacts.len() >= MAX_ARTIFACTS {
            break;
        }
    }
    Publication {
        requested: requested.min(24),
        artifacts,
        error: None,
    }
}

fn source_path(source: &str, data: &Path, cwd: &Path, generated: &Path) -> Option<PathBuf> {
    if let Some(path) = source.strip_prefix("artifacts/generated/") {
        if Path::new(path).components().any(|part| {
            matches!(
                part,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        }) {
            return None;
        }
        let candidate = generated.join(path);
        return candidate.starts_with(generated).then_some(candidate);
    }
    for (token, base) in [
        ("${BUTLER_ARTIFACTS_DIR}", generated),
        ("$BUTLER_ARTIFACTS_DIR", generated),
        ("${BUTLER_ARTIFACT_DIR}", generated),
        ("$BUTLER_ARTIFACT_DIR", generated),
        ("${BUTLER_DATA}", data),
        ("$BUTLER_DATA", data),
    ] {
        if source == token {
            return Some(base.to_path_buf());
        }
        if let Some(suffix) = source
            .strip_prefix(token)
            .and_then(|value| value.strip_prefix('/'))
        {
            return Some(base.join(suffix));
        }
    }
    let path = Path::new(source);
    Some(if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    })
}

fn verified_source(path: &Path, workspace: &Path, generated: &Path) -> Option<(PathBuf, Vec<u8>)> {
    let link = fs::symlink_metadata(path).ok()?;
    if !link.is_file() || link.file_type().is_symlink() || link.len() == 0 || link.len() > MAX_BYTES
    {
        return None;
    }
    let real = fs::canonicalize(path).ok()?;
    if !real.starts_with(workspace) && !real.starts_with(generated) {
        return None;
    }
    let before = fs::symlink_metadata(&real).ok()?;
    if !before.is_file() || before.file_type().is_symlink() {
        return None;
    }
    let bytes = fs::read(&real).ok()?;
    let after = fs::symlink_metadata(&real).ok()?;
    if bytes.len() as u64 != before.len() || !same_file(&before, &after) {
        return None;
    }
    Some((real, bytes))
}

fn publish_file(root: &Path, source: &Path, bytes: &[u8]) -> Option<PathBuf> {
    let hash = format!("{:x}", Sha256::digest(bytes));
    let directory = root.join("published").join(hash);
    fs::create_dir_all(&directory).ok()?;
    let safe = safe_name(source.file_name()?.to_str()?);
    let destination = directory.join(safe);
    if !fs::canonicalize(&directory).ok()?.starts_with(root) {
        return None;
    }
    if destination.exists() {
        let stat = fs::symlink_metadata(&destination).ok()?;
        if !stat.is_file() || stat.file_type().is_symlink() || stat.len() != bytes.len() as u64 {
            return None;
        }
        return (fs::read(&destination).ok()?.as_slice() == bytes).then_some(destination);
    }
    let temporary = directory.join(format!(".{}.tmp", Uuid::new_v4()));
    let written = (|| {
        use std::io::Write;
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).ok()?;
        file.write_all(bytes).ok()?;
        fs::rename(&temporary, &destination).ok()?;
        (fs::read(&destination).ok()?.as_slice() == bytes).then_some(destination)
    })();
    let _ = fs::remove_file(&temporary);
    written
}

fn safe_name(source: &str) -> String {
    let clean: String = source
        .nfc()
        .map(|ch| {
            if ch.is_alphanumeric() || "_ .@()+-[]".contains(ch) {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let clean = crate::public_text::trim_js_whitespace(&clean);
    let clean = if clean.is_empty() || clean == "." || clean == ".." {
        "attachment"
    } else {
        clean
    };
    clean.chars().take(120).collect()
}

fn scan(data: &Path) -> Vec<File> {
    let root = data.join("artifacts/generated");
    if !root.exists() {
        return Vec::new();
    }
    let root = canonical(&root);
    let mut result = Vec::new();
    let mut count = 0;
    let collator = LocaleCollation::new("en-US").ok();
    visit(&root, &root, 0, &mut count, &mut result, collator.as_ref());
    result
}

fn visit(
    root: &Path,
    dir: &Path,
    depth: usize,
    count: &mut usize,
    out: &mut Vec<File>,
    collator: Option<&LocaleCollation>,
) {
    if depth > MAX_DEPTH || *count >= MAX_FILES {
        return;
    }
    let Ok(read) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = read.flatten().collect();
    entries.sort_by(|a, b| {
        let left = a.file_name().to_string_lossy().into_owned();
        let right = b.file_name().to_string_lossy().into_owned();
        collator.map_or_else(
            || left.cmp(&right),
            |collator| collator.compare(&left, &right),
        )
    });
    for entry in entries {
        if *count >= MAX_FILES {
            return;
        }
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            visit(root, &entry.path(), depth + 1, count, out, collator);
            continue;
        }
        if !kind.is_file() {
            continue;
        }
        *count += 1;
        let Ok(real) = fs::canonicalize(entry.path()) else {
            continue;
        };
        if !real.starts_with(root) {
            continue;
        }
        let Ok(stat) = fs::symlink_metadata(&real) else {
            continue;
        };
        if !stat.is_file() || stat.file_type().is_symlink() {
            continue;
        }
        let Ok(relative) = real.strip_prefix(root) else {
            continue;
        };
        let modified = stat.modified().unwrap_or(std::time::UNIX_EPOCH);
        out.push(File {
            relative: relative.to_string_lossy().replace('\\', "/"),
            path: real,
            fingerprint: format!(
                "{}:{}:{}:{}",
                file_id(&stat),
                stat.len(),
                millis(modified),
                change_millis(&stat)
            ),
            size: stat.len(),
            modified,
        });
    }
}

fn artifact(file: &File) -> Artifact {
    Artifact {
        path: format!("artifacts/generated/{}", file.relative),
        artifact_kind: kind(&file.path),
        size_bytes: file.size,
        modified_at: iso(file.modified),
    }
}
fn kind(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "csv" => "csv_file",
        "tsv" => "table_file",
        "png" | "jpg" | "jpeg" | "webp" | "svg" | "pdf" => "chart_file",
        _ => "file",
    }
}
fn canonical(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}
fn iso(value: std::time::SystemTime) -> String {
    DateTime::<Utc>::from(value).to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn millis(value: std::time::SystemTime) -> u128 {
    value
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |v| v.as_millis())
}
#[cfg(unix)]
fn change_millis(stat: &fs::Metadata) -> i128 {
    use std::os::unix::fs::MetadataExt;
    i128::from(stat.ctime()) * 1000 + i128::from(stat.ctime_nsec()) / 1_000_000
}
#[cfg(not(unix))]
fn change_millis(stat: &fs::Metadata) -> i128 {
    stat.created().map_or(0, |time| millis(time) as i128)
}
#[cfg(unix)]
fn file_id(stat: &fs::Metadata) -> String {
    use std::os::unix::fs::MetadataExt;
    format!("{}:{}", stat.dev(), stat.ino())
}
#[cfg(not(unix))]
fn file_id(_: &fs::Metadata) -> String {
    String::new()
}
#[cfg(unix)]
fn same_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.len() == right.len()
        && left.mtime() == right.mtime()
        && left.mtime_nsec() == right.mtime_nsec()
}
#[cfg(not(unix))]
fn same_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.len() == right.len() && left.modified().ok() == right.modified().ok()
}
