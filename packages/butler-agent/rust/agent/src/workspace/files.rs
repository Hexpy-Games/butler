use std::path::PathBuf;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::path_guard::{GuardInput, resolve_workspace_path_guard, safe_cursor_path};

#[derive(Debug)]
pub(crate) struct ReadFileInput {
    pub root: PathBuf,
    pub path: String,
    pub relative_only: bool,
    pub protected_roots: Vec<PathBuf>,
    pub start_line: Option<usize>,
    pub limit_lines: Option<usize>,
    pub max_bytes: usize,
    pub offset_bytes: Option<usize>,
}
#[derive(Debug)]
pub(crate) struct WorkspaceFileRead {
    pub result: Value,
    pub sha256: Option<String>,
    pub output_bytes: usize,
    pub bytes_read: usize,
    pub has_more: bool,
    pub cursor_invalid: bool,
    pub start_offset: Option<usize>,
    pub next_offset: Option<usize>,
}
impl WorkspaceFileRead {
    fn failed(result: Value) -> Self {
        Self {
            result,
            sha256: None,
            output_bytes: 0,
            bytes_read: 0,
            has_more: false,
            cursor_invalid: false,
            start_offset: None,
            next_offset: None,
        }
    }
}

fn failure(path: &str, error: &str, message: &str, hint: &str) -> Value {
    json!({ "ok": false, "path": path, "error": error, "message": message, "recovery_hint": hint })
}
fn io_failure(path: &str, error: &std::io::Error, stage: &str) -> Value {
    let absent = error.kind() == std::io::ErrorKind::NotFound;
    match stage {
        "inspect" => failure(
            path,
            if absent { "not_found" } else { "io_error" },
            if absent {
                "The requested workspace file was not found."
            } else {
                "The workspace file could not be inspected."
            },
            if absent {
                "Restart discovery or choose an existing file."
            } else {
                "Check workspace permissions and retry the read."
            },
        ),
        "recheck" => failure(
            path,
            if absent { "not_found" } else { "io_error" },
            if absent {
                "The requested workspace file was not found."
            } else {
                "The workspace file could not be inspected before reading."
            },
            "Check workspace permissions and retry the read.",
        ),
        _ => failure(
            path,
            if absent { "not_found" } else { "io_error" },
            if absent {
                "The requested workspace file was not found."
            } else {
                "The workspace file could not be read."
            },
            "Check workspace permissions and retry the read.",
        ),
    }
}
pub(super) fn read_one_blocking(input: &ReadFileInput) -> std::io::Result<WorkspaceFileRead> {
    let guard = resolve_workspace_path_guard(GuardInput {
        root: &input.root,
        requested: &input.path,
        relative_only: input.relative_only,
        allow_directories: false,
        protected_roots: &input.protected_roots,
    })?;
    let Some((_, file)) = guard.accepted() else {
        let safe = if input.relative_only {
            guard.safe_path().unwrap_or_else(|| ".".into())
        } else {
            input.path.clone()
        };
        return Ok(WorkspaceFileRead::failed(failure(
            &safe,
            if guard.reason == Some("directory_not_allowed") {
                "not_a_file"
            } else {
                guard.reason.unwrap_or("path_rejected")
            },
            "The file path is not an admitted workspace file.",
            "Choose a contained, non-sensitive regular file path.",
        )));
    };
    let metadata = match std::fs::symlink_metadata(file) {
        Ok(value) => value,
        Err(error) => {
            return Ok(WorkspaceFileRead::failed(io_failure(
                &input.path,
                &error,
                "inspect",
            )));
        }
    };
    if !metadata.is_file() {
        return Ok(WorkspaceFileRead::failed(failure(
            &input.path,
            "not_a_file",
            "The requested path is not a regular file.",
            "Choose a regular file path returned by list_files.",
        )));
    }
    let rechecked = match std::fs::symlink_metadata(file) {
        Ok(value) => value,
        Err(error) => {
            return Ok(WorkspaceFileRead::failed(io_failure(
                &input.path,
                &error,
                "recheck",
            )));
        }
    };
    if !rechecked.is_file() {
        return Ok(WorkspaceFileRead::failed(failure(
            &input.path,
            "not_a_file",
            "The requested path is no longer a regular file.",
            "Restart discovery and choose a regular file path returned by list_files.",
        )));
    }
    let data = match std::fs::read(file) {
        Ok(value) => value,
        Err(error) => {
            return Ok(WorkspaceFileRead::failed(io_failure(
                &input.path,
                &error,
                "read",
            )));
        }
    };
    let bytes_read = data.len();
    let sha256 = format!("{:x}", Sha256::digest(&data));
    let failed_bytes =
        |result: Value, cursor_invalid: bool, start_offset: Option<usize>| WorkspaceFileRead {
            result,
            sha256: Some(sha256.clone()),
            output_bytes: 0,
            bytes_read,
            has_more: false,
            cursor_invalid,
            start_offset,
            next_offset: None,
        };
    if data.iter().take(4096).any(|byte| *byte == 0) {
        return Ok(failed_bytes(
            failure(
                &input.path,
                "binary_file_not_supported",
                "Binary workspace files are not supported by read_file.",
                "Choose a UTF-8 text file.",
            ),
            false,
            None,
        ));
    }
    let Ok(mut decoded) = String::from_utf8(data) else {
        return Ok(failed_bytes(
            failure(
                &input.path,
                "invalid_utf8",
                "The workspace file is not valid UTF-8 text.",
                "Choose a UTF-8 text file or convert it before reading.",
            ),
            false,
            None,
        ));
    };
    if decoded.starts_with('\u{feff}') {
        decoded.drain(..3);
    }
    let normalized = normalize_line_endings(decoded);
    if let Some(offset) = input.offset_bytes
        && (offset > normalized.len() || !normalized.is_char_boundary(offset))
    {
        return Ok(failed_bytes(
            failure(
                &input.path,
                "invalid_cursor",
                "The read_file cursor offset is outside the current UTF-8 byte boundaries.",
                "Restart read_file without cursor and continue from a newly issued cursor.",
            ),
            true,
            None,
        ));
    }
    let range_start = char_index_at_line(&normalized, input.start_line.unwrap_or(1));
    let range_end = line_range_end(&normalized, range_start, input.limit_lines);
    let start = input.offset_bytes.unwrap_or(range_start);
    if start < range_start || start > range_end {
        return Ok(failed_bytes(
            failure(
                &input.path,
                "invalid_cursor",
                "The cursor is outside the requested line range.",
                "Restart the requested range without cursor.",
            ),
            true,
            None,
        ));
    }
    let start_line = 1 + normalized[..start]
        .bytes()
        .filter(|byte| *byte == b'\n')
        .count();
    let candidate = &normalized[start..range_end];
    let selected_end = utf8_prefix_end(candidate, input.max_bytes);
    let selected = &candidate[..selected_end];
    if !candidate.is_empty() && selected.is_empty() {
        return Ok(failed_bytes(
            failure(
                &input.path,
                "max_bytes_too_small_for_utf8",
                "The per-file byte budget cannot include the next UTF-8 character without splitting it.",
                "Increase max_bytes to at least the next UTF-8 character size.",
            ),
            false,
            Some(start),
        ));
    }
    let has_more = selected_end < candidate.len();
    let end_line = if selected.is_empty() {
        start_line - 1
    } else {
        start_line + selected.bytes().filter(|byte| *byte == b'\n').count()
    };
    Ok(WorkspaceFileRead {
        result: json!({ "ok": true, "path": input.path, "bytes": bytes_read, "sha256": sha256, "truncated": has_more, "byte_truncated": has_more, "start_line": start_line, "end_line": end_line, "content": selected }),
        sha256: Some(sha256),
        output_bytes: selected.len(),
        bytes_read,
        has_more,
        cursor_invalid: false,
        start_offset: Some(start),
        next_offset: if has_more {
            Some(start + selected.len())
        } else {
            None
        },
    })
}
fn normalize_line_endings(text: String) -> String {
    if !text.contains('\r') {
        return text;
    }
    // CRLF and a lone CR both become LF.
    text.replace("\r\n", "\n").replace('\r', "\n")
}
fn char_index_at_line(text: &str, line: usize) -> usize {
    if line <= 1 {
        return 0;
    }
    let mut current = 1;
    for (index, byte) in text.bytes().enumerate() {
        if byte == b'\n' {
            current += 1;
            if current >= line {
                return index + 1;
            }
        }
    }
    text.len()
}
fn line_range_end(text: &str, start: usize, limit: Option<usize>) -> usize {
    let Some(limit) = limit else {
        return text.len();
    };
    let mut seen = 0;
    for (index, byte) in text.bytes().enumerate().skip(start) {
        if byte == b'\n' {
            seen += 1;
            if seen >= limit {
                return index;
            }
        }
    }
    text.len()
}
pub(crate) fn utf8_prefix_end(text: &str, max_bytes: usize) -> usize {
    if text.len() <= max_bytes {
        return text.len();
    }
    let mut end = 0;
    for (index, character) in text.char_indices() {
        if index + character.len_utf8() > max_bytes {
            break;
        }
        end = index + character.len_utf8();
    }
    end
}
pub(crate) fn cursor_path(path: &str) -> Option<&str> {
    safe_cursor_path(path).then_some(path)
}
