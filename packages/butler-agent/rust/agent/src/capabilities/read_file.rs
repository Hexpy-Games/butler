mod contracts;
pub(super) use contracts::definition;
use contracts::{Request, integer, normalize_request, parse_args};

use std::path::PathBuf;
use std::time::Instant;

use serde_json::{Value, json};

use super::{CapabilityError, CapabilityInvocation, cursor, evidence, failure};
use crate::workspace::{NativeWorkspaceFiles, ReadFileInput, WorkspaceFileRead, utf8_prefix_end};

const DEFAULT_TOTAL_BYTES: usize = 1_048_576;

pub(super) async fn execute(
    workspace: &NativeWorkspaceFiles,
    input: CapabilityInvocation<'_>,
) -> Result<Value, CapabilityError> {
    let started = Instant::now();
    let args = match parse_args(input.call) {
        Ok(value) => value,
        Err((code, detail)) => {
            let mut result = failure(
                code,
                "Tool arguments must be a JSON object.",
                "Retry read_file with 1-20 canonical request objects.",
            );
            result["detail"] = json!(detail);
            return Ok(result);
        }
    };
    let requests = match args.get("requests").and_then(Value::as_array) {
        Some(items) if !items.is_empty() && items.len() <= 20 => items
            .iter()
            .map(normalize_request)
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .collect::<Option<Vec<_>>>(),
        _ => None,
    };
    let Some(requests) = requests else {
        return Ok(failure(
            "invalid_arguments",
            "requests must contain 1-20 objects with a path.",
            "Retry with 1-20 canonical request objects.",
        ));
    };
    let max_total = integer(
        args.get("max_total_bytes"),
        DEFAULT_TOTAL_BYTES,
        1,
        4_194_304,
    )?;
    let bound_root = if let Some(reference) = input.workspace_reference {
        Some(
            reference
                .get()
                .map_err(|error| CapabilityError { code: error.code })?,
        )
    } else {
        input
            .workspace_path
            .filter(|p| !crate::public_text::trim_js_whitespace(&p.to_string_lossy()).is_empty())
            .map(ToOwned::to_owned)
    };
    let supplied_root_raw = args
        .get("workspace_root")
        .and_then(Value::as_str)
        .filter(|s| !crate::public_text::trim_js_whitespace(s).is_empty());
    let supplied_root = supplied_root_raw.map(crate::public_text::trim_js_whitespace);
    let root = bound_root
        .clone()
        .or_else(|| supplied_root_raw.map(PathBuf::from))
        .unwrap_or_else(|| input.butler_data.to_path_buf());
    let query_value = json!({ "workspace_root": root.to_string_lossy(), "requests": requests.iter().map(Request::query_value).collect::<Vec<_>>(), "max_total_bytes": max_total });
    let query = cursor::query_hash(&query_value).map_err(|_| CapabilityError {
        code: "cursor_query_json_failed".into(),
    })?;
    let cursor_input = args.get("cursor").filter(|v| {
        v.as_str()
            .is_none_or(|s| !crate::public_text::trim_js_whitespace(s).is_empty())
    });
    let cursor = cursor_input.and_then(cursor::decode);
    if cursor_input.is_some() && cursor.as_ref().is_none_or(|value| value.query != query) {
        return Ok(cursor_error(
            "invalid_cursor",
            "The read_file cursor is malformed or does not match the current request options.",
            "Restart read_file with the same requests and omit cursor.",
        ));
    }
    let cursor_index = cursor.as_ref().map_or(0, |value| value.request_index);
    if cursor_index >= requests.len() {
        return Ok(cursor_error(
            "invalid_cursor",
            "The read_file cursor points outside the requested batch.",
            "Restart the batch without cursor.",
        ));
    }
    if let (Some(_), Some(supplied)) = (&bound_root, supplied_root) {
        for request in &requests {
            let guard = workspace
                .guard(
                    PathBuf::from(supplied),
                    request.path.clone(),
                    input.allowed_tools_and_effects.is_some(),
                    input.protected_ledger_roots.to_vec(),
                )
                .await
                .map_err(owner_error)?
                .map_err(guard_io_error)?;
            if guard.reason == Some("protected_path") {
                let mut result = failure(
                    "protected_path",
                    "Project Ledger files must be inspected through their dedicated tool policy.",
                    "Use the admitted workspace root or the Project Ledger inspection tools.",
                );
                if let Some(path) = guard.safe_path() {
                    result["path"] = json!(path);
                }
                result["guard"] = guard.public_rejection();
                return Ok(result);
            }
        }
    }
    let mut results = Vec::with_capacity(requests.len());
    let (mut total_input, mut total_output, mut files_read) = (0usize, 0usize, 0usize);
    let mut next_cursor: Option<String> = None;
    let mut truncated = false;
    let mut stopped_by: Option<&str> = None;
    for (index, request) in requests.iter().enumerate() {
        if index < cursor_index {
            results.push(json!({ "ok": true, "path": request.path, "skipped": true, "content": "", "bytes": 0, "truncated": false }));
            continue;
        }
        let offset = if index == cursor_index {
            cursor.as_ref().map(|value| value.offset_bytes)
        } else {
            None
        };
        let mut read = workspace
            .read_one(ReadFileInput {
                root: root.clone(),
                path: request.path.clone(),
                relative_only: input.allowed_tools_and_effects.is_some(),
                protected_roots: input.protected_ledger_roots.to_vec(),
                start_line: request.start_line,
                limit_lines: request.limit_lines,
                max_bytes: request.max_bytes,
                offset_bytes: offset,
            })
            .await
            .map_err(owner_error)?
            .map_err(guard_io_error)?;
        total_input += read.bytes_read;
        if let Some(value) = &cursor {
            if index == cursor_index && read.sha256.as_deref() != Some(&value.file_sha256) {
                return Ok(cursor_error(
                    "cursor_stale",
                    "The partially-read file changed after the cursor was issued.",
                    "Restart read_file for that file without cursor and re-read its current contents.",
                ));
            }
            if index == cursor_index && read.cursor_invalid {
                return Ok(cursor_error(
                    "invalid_cursor",
                    "The read_file cursor offset is outside the current UTF-8 byte boundaries.",
                    "Restart read_file without cursor and continue from a newly issued cursor.",
                ));
            }
        }
        if read.result.get("ok") != Some(&Value::Bool(true)) {
            results.push(read.result);
            continue;
        }
        if total_output >= max_total {
            truncated = true;
            stopped_by = Some("max_total_bytes");
            next_cursor = Some(make_cursor(
                &query,
                index,
                read.start_offset.or(offset).unwrap_or(0),
                request,
                &read,
            ));
            results.push(pending(&request.path));
            add_pending(&mut results, &requests[index + 1..]);
            break;
        }
        let available = max_total - total_output;
        if read.output_bytes > available {
            stopped_by = Some("max_total_bytes");
            let content = read
                .result
                .get("content")
                .and_then(Value::as_str)
                .expect("successful content");
            let end = utf8_prefix_end(content, available);
            if end == 0 && read.output_bytes > 0 {
                truncated = true;
                results.push(json!({ "ok": false, "path": request.path, "error": "max_total_bytes", "message": "The aggregate read byte budget cannot include the next UTF-8 character without splitting it.", "recovery_hint": "Increase max_total_bytes and retry this request." }));
                add_pending(&mut results, &requests[index + 1..]);
                break;
            }
            let start_line = read.result["start_line"].as_u64().expect("successful line");
            let line_count = content[..end].bytes().filter(|b| *b == b'\n').count() as u64;
            read.result["end_line"] = json!(if end == 0 {
                start_line.saturating_sub(1)
            } else {
                start_line + line_count
            });
            let Value::String(content) = &mut read.result["content"] else {
                unreachable!("successful content is a string")
            };
            content.truncate(end);
            read.result["byte_truncated"] = json!(true);
            read.result["truncated"] = json!(true);
            read.output_bytes = end;
            truncated = true;
            next_cursor = Some(make_cursor(
                &query,
                index,
                read.start_offset.or(offset).unwrap_or(0) + end,
                request,
                &read,
            ));
        } else if read.has_more {
            truncated = true;
            stopped_by = Some("max_bytes");
            next_cursor = Some(make_cursor(
                &query,
                index,
                read.next_offset.expect("has more offset"),
                request,
                &read,
            ));
        }
        total_output += read.output_bytes;
        files_read += 1;
        results.push(read.result);
        if next_cursor.is_some() {
            add_pending(&mut results, &requests[index + 1..]);
            break;
        }
    }
    let continued = next_cursor.is_some();
    let truncated = truncated || continued;
    let references = evidence::execution_references(&results);
    let ok = results.iter().any(|result| {
        result.get("ok") == Some(&Value::Bool(true))
            && result.get("skipped") != Some(&Value::Bool(true))
    });
    let elapsed = started.elapsed().as_millis() as u64;
    let capability_receipts = evidence::read_capability(ok, truncated, &results);
    let mut result = json!({ "ok": ok, "files_requested": requests.len(), "files_read": files_read,
        "bytes_read": total_input, "output_bytes": total_output, "truncated": truncated,
        "metrics": { "elapsed_ms": elapsed, "files_read": files_read, "bytes_read": total_input, "output_bytes": total_output, "files_requested": requests.len() },
        "evidence_receipts": evidence::execution(files_read, &references, truncated, continued),
        "evidence_capability_receipts": capability_receipts });
    result["files"] = Value::Array(results);
    if !ok {
        result["error"] = json!("all_files_failed");
        result["message"] = json!("No requested file produced a usable result.");
    }
    if let Some(reason) = stopped_by {
        result["stopped_by"] = json!(reason);
    }
    if let Some(value) = next_cursor {
        result["next_cursor"] = json!(value);
    }
    Ok(result)
}
fn owner_error(error: crate::workspace::FileOwnerError) -> CapabilityError {
    CapabilityError {
        code: error.code.into(),
    }
}
fn guard_io_error(error: std::io::Error) -> CapabilityError {
    let code = match error.kind() {
        std::io::ErrorKind::NotFound => "ENOENT",
        std::io::ErrorKind::PermissionDenied => "EACCES",
        std::io::ErrorKind::NotADirectory => "ENOTDIR",
        _ => "workspace_guard_io",
    };
    CapabilityError { code: code.into() }
}
fn make_cursor(
    query: &str,
    index: usize,
    offset: usize,
    request: &Request,
    read: &WorkspaceFileRead,
) -> String {
    cursor::encode(
        query,
        index,
        offset,
        &request.path,
        read.sha256.as_deref().expect("successful read SHA"),
    )
}
fn add_pending(results: &mut Vec<Value>, requests: &[Request]) {
    for request in requests {
        results.push(pending(&request.path));
    }
}
fn pending(path: &str) -> Value {
    json!({ "ok": true, "path": path, "skipped": true, "pending": true, "content": "", "bytes": 0, "truncated": true, "message": "This request has not been read on this page." })
}
fn cursor_error(error: &str, message: &str, hint: &str) -> Value {
    json!({ "ok": false, "error": error, "message": message, "recovery_hint": hint })
}
