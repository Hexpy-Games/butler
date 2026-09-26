use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

use chrono::{DateTime, SecondsFormat, Utc};

use super::super::artifacts::Artifact;

const MAX_ARTIFACTS: usize = 24;

pub(super) fn unique(artifacts: &mut Vec<Artifact>) {
    let mut seen = HashSet::new();
    artifacts.retain(|artifact| seen.insert(artifact.path.clone()));
}

fn canonical_if_exists(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn inside(path: &Path, root: &Path) -> bool {
    canonical_if_exists(path).starts_with(canonical_if_exists(root))
}

fn expand(source: &str, data: &Path) -> PathBuf {
    let generated = data.join("artifacts/generated");
    for (token, base) in [
        ("${BUTLER_ARTIFACTS_DIR}", generated.as_path()),
        ("$BUTLER_ARTIFACTS_DIR", generated.as_path()),
        ("${BUTLER_ARTIFACT_DIR}", generated.as_path()),
        ("$BUTLER_ARTIFACT_DIR", generated.as_path()),
        ("${BUTLER_DATA}", data),
        ("$BUTLER_DATA", data),
    ] {
        if source == token {
            return base.to_path_buf();
        }
        if let Some(suffix) = source
            .strip_prefix(token)
            .and_then(|rest| rest.strip_prefix('/'))
        {
            return base.join(suffix);
        }
    }
    PathBuf::from(source)
}

fn lexical(path: &Path) -> PathBuf {
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                clean.pop();
            }
            other => clean.push(other.as_os_str()),
        }
    }
    clean
}

fn candidates(source: &str, cwd: &Path, data: &Path) -> Vec<PathBuf> {
    let source = crate::public_text::trim_js_whitespace(source);
    if source.is_empty() {
        return Vec::new();
    }
    let source = expand(source, data);
    if source.is_absolute() {
        return vec![lexical(&source)];
    }
    let mut paths = vec![
        lexical(&cwd.join(&source)),
        lexical(&data.join(&source)),
        lexical(&data.join("artifacts/generated").join(source)),
    ];
    paths.dedup();
    paths
}

fn label(path: &Path, cwd: &Path, data: &Path) -> String {
    let artifacts = data.join("artifacts");
    if let Ok(relative) = path.strip_prefix(&artifacts)
        && !relative.as_os_str().is_empty()
    {
        return Path::new("artifacts")
            .join(relative)
            .to_string_lossy()
            .into_owned();
    }
    if let Ok(relative) = path.strip_prefix(cwd)
        && !relative.as_os_str().is_empty()
    {
        return relative.to_string_lossy().into_owned();
    }
    let mut source = path.components().peekable();
    let mut base = cwd.components().peekable();
    while source.peek().is_some() && source.peek() == base.peek() {
        source.next();
        base.next();
    }
    let mut relative = PathBuf::new();
    for _ in base {
        relative.push("..");
    }
    for component in source {
        relative.push(component);
    }
    if relative.as_os_str().is_empty() {
        "command-output".into()
    } else {
        relative.to_string_lossy().into_owned()
    }
}

pub(super) fn verified(
    path: &Path,
    cwd: &Path,
    workspace: &Path,
    data: &Path,
    allow_workspace: bool,
) -> Option<Artifact> {
    let workspace_allowed = allow_workspace && inside(path, workspace);
    let artifact_allowed = inside(path, &data.join("artifacts"));
    if !workspace_allowed && !artifact_allowed {
        return None;
    }
    let stat = std::fs::metadata(path).ok()?;
    if !stat.is_file() {
        return None;
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let kind = match extension.as_str() {
        "csv" => "csv_file",
        "tsv" => "table_file",
        "png" | "jpg" | "jpeg" | "webp" | "svg" | "pdf" => "chart_file",
        _ => "file",
    };
    Some(Artifact {
        path: label(path, cwd, data),
        artifact_kind: kind,
        size_bytes: stat.len(),
        modified_at: DateTime::<Utc>::from(stat.modified().ok()?)
            .to_rfc3339_opts(SecondsFormat::Millis, true),
    })
}

pub(super) fn from_paths(
    paths: &[String],
    cwd: &Path,
    workspace: &Path,
    data: &Path,
    allow_workspace: bool,
) -> Vec<Artifact> {
    let mut artifacts = Vec::new();
    for source in paths.iter().take(MAX_ARTIFACTS) {
        for path in candidates(source, cwd, data) {
            if let Some(artifact) = verified(&path, cwd, workspace, data, allow_workspace) {
                artifacts.push(artifact);
                break;
            }
        }
    }
    unique(&mut artifacts);
    artifacts
}
