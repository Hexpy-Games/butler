use std::path::{Path, PathBuf};

use serde_json::Value;

use super::*;
use crate::context::tool_artifact_slice::{SliceInput, slice_tool_artifact_text};
use crate::public_text::trim_js_whitespace;

pub(super) fn read(
    butler_data: &Path,
    estimator: &OwnedDefaultTokenEstimator,
    input: &ReadToolOutputInput,
) -> ContextResult<FocusedToolOutputArtifactRead> {
    let root = butler_data.join("artifacts/tool-output");
    let path = match reference(&root, input, None)? {
        Ok(path) => path,
        Err(error) => return Ok(failure(error)),
    };
    if !path.exists() {
        return Ok(failure("artifact_not_found"));
    }
    let Some(artifact) = read_artifact(&path) else {
        return Ok(failure("artifact_unreadable"));
    };
    let Some(result) = artifact.get("result").and_then(Value::as_object) else {
        return Ok(failure("artifact_invalid"));
    };
    let stdout = result.get("stdout").and_then(Value::as_str).unwrap_or("");
    let stderr = result.get("stderr").and_then(Value::as_str).unwrap_or("");
    let offset_lines = input.offset_lines.map(nonnegative_trunc).unwrap_or(0);
    let offset_chars = input
        .offset_chars
        .filter(|value| value.is_finite())
        .map(nonnegative_trunc);
    let limit_lines =
        crate::json::saturating_usize(input.limit_lines.unwrap_or(80.0).trunc().clamp(1.0, 500.0));
    let max_tokens = crate::json::saturating_usize(
        input
            .max_tokens
            .unwrap_or(1_200.0)
            .trunc()
            .clamp(50.0, 8_000.0),
    );
    let stdout_has_text = !trim_js_whitespace(stdout).is_empty();
    let stderr_has_text = !trim_js_whitespace(stderr).is_empty();
    let stdout_tokens = if input.stream == ArtifactStream::Both && stderr_has_text {
        (max_tokens / 2).max(25)
    } else {
        max_tokens
    };
    let stderr_tokens = if input.stream == ArtifactStream::Both && stdout_has_text {
        (max_tokens / 2).max(25)
    } else {
        max_tokens
    };
    let stdout_slice = if input.stream == ArtifactStream::Stderr {
        None
    } else {
        Some(slice_tool_artifact_text(
            estimator,
            SliceInput {
                text: stdout,
                offset_lines,
                offset_chars,
                search: input.search.as_deref(),
                limit_lines,
                max_tokens: stdout_tokens,
            },
        )?)
    };
    let stderr_slice = if input.stream == ArtifactStream::Stdout {
        None
    } else {
        Some(slice_tool_artifact_text(
            estimator,
            SliceInput {
                text: stderr,
                offset_lines,
                offset_chars,
                search: input.search.as_deref(),
                limit_lines,
                max_tokens: stderr_tokens,
            },
        )?)
    };
    let metadata = ToolOutputArtifactMetadata {
        id: artifact
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| {
                path.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned()
            }),
        path,
        created_at: artifact
            .get("created_at")
            .and_then(Value::as_str)
            .map(str::to_owned),
        command: artifact
            .get("command")
            .and_then(Value::as_str)
            .map(str::to_owned),
        cwd: artifact
            .get("cwd")
            .and_then(Value::as_str)
            .map(str::to_owned),
        raw_tokens: artifact.get("raw_tokens").and_then(Value::as_f64),
    };
    Ok(FocusedToolOutputArtifactRead {
        ok: true,
        error: None,
        artifact: Some(metadata),
        stdout: stdout_slice,
        stderr: stderr_slice,
        requested_max_tokens: input.max_tokens,
        applied_max_tokens: Some(max_tokens),
        requested_limit_lines: input.limit_lines,
        applied_limit_lines: Some(limit_lines),
    })
}

fn failure(error: &'static str) -> FocusedToolOutputArtifactRead {
    FocusedToolOutputArtifactRead {
        ok: false,
        error: Some(error),
        artifact: None,
        stdout: None,
        stderr: None,
        requested_max_tokens: None,
        applied_max_tokens: None,
        requested_limit_lines: None,
        applied_limit_lines: None,
    }
}

fn nonnegative_trunc(value: f64) -> usize {
    crate::json::saturating_usize(value.trunc().max(0.0))
}

fn read_artifact(path: &Path) -> Option<Value> {
    let bytes = std::fs::read(path).ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    value.as_object()?;
    Some(value)
}

pub(super) fn reference(
    root: &Path,
    input: &ReadToolOutputInput,
    required_schema: Option<&str>,
) -> ContextResult<Result<PathBuf, &'static str>> {
    if let Some(path) = input
        .path
        .as_ref()
        .and_then(|path| path.to_str())
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        let path = lexical_absolute(Path::new(path))?;
        if !under_root(&path, root)? {
            return Ok(Err("unsafe_artifact_path"));
        }
        return Ok(Ok(path));
    }
    if let Some(id) = input
        .artifact_id
        .as_ref()
        .filter(|id| !id.trim().is_empty())
    {
        let id = id.trim();
        if id.contains('/') || id.contains('\\') {
            return Ok(Err("artifact_not_found"));
        }
        let limit = input.max_artifact_scan_files.unwrap_or(10_000).max(1);
        let mut files = Vec::new();
        walk_files(root, limit.saturating_add(1), &mut files)?;
        if files.len() > limit {
            return Ok(Err("artifact_scan_limit_exceeded"));
        }
        for path in files {
            if path.extension().is_none_or(|extension| extension != "json") {
                continue;
            }
            let artifact = read_artifact(&path);
            if artifact
                .as_ref()
                .and_then(|value| value.get("id"))
                .and_then(Value::as_str)
                == Some(id)
                && required_schema.is_none_or(|schema| {
                    artifact
                        .as_ref()
                        .and_then(|value| value.get("schema"))
                        .and_then(Value::as_str)
                        == Some(schema)
                })
            {
                return Ok(Ok(path));
            }
        }
        return Ok(Err("artifact_not_found"));
    }
    Ok(Err("artifact_reference_required"))
}

pub(super) fn walk_files(
    root: &Path,
    max_files: usize,
    files: &mut Vec<PathBuf>,
) -> ContextResult<()> {
    if !root.exists() {
        return Ok(());
    }
    if files.len() >= max_files {
        return Ok(());
    }
    for entry in std::fs::read_dir(root).map_err(io_error)? {
        if files.len() >= max_files {
            break;
        }
        let entry = entry.map_err(io_error)?;
        let kind = entry.file_type().map_err(io_error)?;
        if kind.is_dir() {
            walk_files(&entry.path(), max_files, files)?;
        } else if kind.is_file() {
            files.push(entry.path());
        }
    }
    Ok(())
}

fn lexical_absolute(path: &Path) -> ContextResult<PathBuf> {
    let base = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().map_err(io_error)?.join(path)
    };
    let mut clean = PathBuf::new();
    for part in base.components() {
        match part {
            std::path::Component::ParentDir => {
                clean.pop();
            }
            std::path::Component::CurDir => {}
            part => clean.push(part.as_os_str()),
        }
    }
    Ok(clean)
}

fn under_root(path: &Path, root: &Path) -> ContextResult<bool> {
    let path = lexical_absolute(path)?;
    let root = lexical_absolute(root)?;
    if !path.starts_with(&root) {
        return Ok(false);
    }
    let real_root = if root.exists() {
        root.canonicalize().map_err(io_error)?
    } else {
        root
    };
    let real_path = if path.exists() {
        path.canonicalize().map_err(io_error)?
    } else {
        path
    };
    Ok(real_path.starts_with(real_root))
}

#[expect(
    clippy::needless_pass_by_value,
    reason = "map_err/iterator adapter taking owned values"
)]
fn io_error(error: std::io::Error) -> ContextError {
    ContextError::new("tool_output_io_error", error.to_string())
}
