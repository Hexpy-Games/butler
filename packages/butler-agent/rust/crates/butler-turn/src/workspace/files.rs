use std::path::PathBuf;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::path_guard::{GuardInput, resolve_workspace_path_guard, safe_cursor_path};

/// A window read of one workspace file.
#[derive(Debug)]
pub struct ReadFileInput {
    pub root: PathBuf,
    pub path: String,
    pub path_form: super::PathForm,
    pub protected_roots: Vec<PathBuf>,
    pub start_line: Option<usize>,
    pub limit_lines: Option<usize>,
    pub max_bytes: usize,
    pub offset_bytes: Option<usize>,
}
/// A file read's model-facing result and cursor facts.
#[derive(Debug)]
pub struct WorkspaceFileRead {
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
/// Which filesystem step of a read failed; each has its own model-facing wording.
#[derive(Clone, Copy)]
enum ReadStage {
    /// The first metadata check of the admitted path.
    Inspect,
    /// The metadata re-check right before reading.
    Recheck,
    /// Reading the file bytes.
    Read,
}

fn io_failure(path: &str, error: &std::io::Error, stage: ReadStage) -> Value {
    let absent = error.kind() == std::io::ErrorKind::NotFound;
    let code = if absent { "not_found" } else { "io_error" };
    let not_found = "The requested workspace file was not found.";
    let retry = "Check workspace permissions and retry the read.";
    match stage {
        ReadStage::Inspect => failure(
            path,
            code,
            if absent {
                not_found
            } else {
                "The workspace file could not be inspected."
            },
            if absent {
                "Restart discovery or choose an existing file."
            } else {
                retry
            },
        ),
        ReadStage::Recheck => failure(
            path,
            code,
            if absent {
                not_found
            } else {
                "The workspace file could not be inspected before reading."
            },
            retry,
        ),
        ReadStage::Read => failure(
            path,
            code,
            if absent {
                not_found
            } else {
                "The workspace file could not be read."
            },
            retry,
        ),
    }
}

/// Reads one admitted workspace text file window: path guard, regular-file
/// checks, UTF-8 decoding, then the line/cursor/byte-budget window.
pub(super) fn read_one_blocking(input: &ReadFileInput) -> std::io::Result<WorkspaceFileRead> {
    let file = match admitted_file(input)? {
        Ok(file) => file,
        Err(failure) => return Ok(WorkspaceFileRead::failed(failure)),
    };
    let data = match std::fs::read(&file) {
        Ok(value) => value,
        Err(error) => {
            return Ok(WorkspaceFileRead::failed(io_failure(
                &input.path,
                &error,
                ReadStage::Read,
            )));
        }
    };
    let read = BytesRead {
        sha256: format!("{:x}", Sha256::digest(&data)),
        bytes_read: data.len(),
    };
    let text = match decode_text(input, data) {
        Ok(text) => text,
        Err(failure) => return Ok(read.rejected(failure, None)),
    };
    Ok(read_window(input, &text, read))
}

/// The admitted regular file behind the requested path, checked twice so a
/// path swapped for a non-file between the checks is refused.
fn admitted_file(input: &ReadFileInput) -> std::io::Result<Result<PathBuf, Value>> {
    let guard = resolve_workspace_path_guard(GuardInput {
        root: &input.root,
        requested: &input.path,
        path_form: input.path_form,
        allow_directories: false,
        protected_roots: &input.protected_roots,
    })?;
    let Some((_, file)) = guard.accepted() else {
        let safe = if input.path_form == super::PathForm::RelativeOnly {
            guard.safe_path().unwrap_or_else(|| ".".into())
        } else {
            input.path.clone()
        };
        return Ok(Err(failure(
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
    let checks = [
        (
            ReadStage::Inspect,
            "The requested path is not a regular file.",
            "Choose a regular file path returned by list_files.",
        ),
        (
            ReadStage::Recheck,
            "The requested path is no longer a regular file.",
            "Restart discovery and choose a regular file path returned by list_files.",
        ),
    ];
    for (stage, message, hint) in checks {
        let metadata = match std::fs::symlink_metadata(file) {
            Ok(value) => value,
            Err(error) => {
                return Ok(Err(io_failure(&input.path, &error, stage)));
            }
        };
        if !metadata.is_file() {
            return Ok(Err(failure(&input.path, "not_a_file", message, hint)));
        }
    }
    Ok(Ok(file.to_path_buf()))
}

/// Digest and size of the bytes read; failures after the read report them.
struct BytesRead {
    sha256: String,
    bytes_read: usize,
}

impl BytesRead {
    fn rejected(&self, result: Value, start_offset: Option<usize>) -> WorkspaceFileRead {
        WorkspaceFileRead {
            sha256: Some(self.sha256.clone()),
            bytes_read: self.bytes_read,
            start_offset,
            ..WorkspaceFileRead::failed(result)
        }
    }

    fn cursor_rejected(&self, result: Value) -> WorkspaceFileRead {
        WorkspaceFileRead {
            cursor_invalid: true,
            ..self.rejected(result, None)
        }
    }
}

/// UTF-8 text without BOM and with LF line endings; binary files are refused.
fn decode_text(input: &ReadFileInput, data: Vec<u8>) -> Result<String, Value> {
    if data.iter().take(4096).any(|byte| *byte == 0) {
        return Err(failure(
            &input.path,
            "binary_file_not_supported",
            "Binary workspace files are not supported by read_file.",
            "Choose a UTF-8 text file.",
        ));
    }
    let Ok(mut decoded) = String::from_utf8(data) else {
        return Err(failure(
            &input.path,
            "invalid_utf8",
            "The workspace file is not valid UTF-8 text.",
            "Choose a UTF-8 text file or convert it before reading.",
        ));
    };
    if decoded.starts_with('\u{feff}') {
        decoded.drain(..3);
    }
    Ok(normalize_line_endings(decoded))
}

/// Selects the requested line range from the cursor, bounded by the byte
/// budget without splitting a UTF-8 character.
fn read_window(input: &ReadFileInput, normalized: &str, read: BytesRead) -> WorkspaceFileRead {
    if let Some(offset) = input.offset_bytes
        && (offset > normalized.len() || !normalized.is_char_boundary(offset))
    {
        return read.cursor_rejected(failure(
            &input.path,
            "invalid_cursor",
            "The read_file cursor offset is outside the current UTF-8 byte boundaries.",
            "Restart read_file without cursor and continue from a newly issued cursor.",
        ));
    }
    let range_start = char_index_at_line(normalized, input.start_line.unwrap_or(1));
    let range_end = line_range_end(normalized, range_start, input.limit_lines);
    let start = input.offset_bytes.unwrap_or(range_start);
    let window = (start >= range_start)
        .then(|| Some((normalized.get(..start)?, normalized.get(start..range_end)?)))
        .flatten();
    let Some((before, candidate)) = window else {
        return read.cursor_rejected(failure(
            &input.path,
            "invalid_cursor",
            "The cursor is outside the requested line range.",
            "Restart the requested range without cursor.",
        ));
    };
    let start_line = 1 + before.bytes().filter(|byte| *byte == b'\n').count();
    let selected_end = utf8_prefix_end(candidate, input.max_bytes);
    let selected = candidate.get(..selected_end).unwrap_or_default();
    if !candidate.is_empty() && selected.is_empty() {
        return read.rejected(
            failure(
                &input.path,
                "max_bytes_too_small_for_utf8",
                "The per-file byte budget cannot include the next UTF-8 character without splitting it.",
                "Increase max_bytes to at least the next UTF-8 character size.",
            ),
            Some(start),
        );
    }
    let has_more = selected_end < candidate.len();
    let end_line = if selected.is_empty() {
        start_line - 1
    } else {
        start_line + selected.bytes().filter(|byte| *byte == b'\n').count()
    };
    let BytesRead { sha256, bytes_read } = read;
    WorkspaceFileRead {
        result: json!({ "ok": true, "path": input.path, "bytes": bytes_read, "sha256": sha256, "truncated": has_more, "byte_truncated": has_more, "start_line": start_line, "end_line": end_line, "content": selected }),
        sha256: Some(sha256),
        output_bytes: selected.len(),
        bytes_read,
        has_more,
        cursor_invalid: false,
        start_offset: Some(start),
        next_offset: has_more.then(|| start + selected.len()),
    }
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
/// The end of the longest prefix of at most `max_bytes` that ends on a char boundary.
pub fn utf8_prefix_end(text: &str, max_bytes: usize) -> usize {
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
/// The path when it is safe to put in a cursor.
pub fn cursor_path(path: &str) -> Option<&str> {
    safe_cursor_path(path).then_some(path)
}
