//! Source-compatible bounded workspace file discovery.

mod cursor;

use std::path::PathBuf;
use std::time::Instant;

use serde_json::{Value, json};

use super::{CapabilityError, CapabilityInvocation, evidence};
use crate::workspace::{
    NativeWorkspaceFiles, WorkspaceListInput, WorkspaceListLimits, WorkspaceListOutcome,
};

pub(super) fn definition() -> Value {
    json!({
        "type":"function", "name":"list_files",
        "description":"Discover regular files under a guarded workspace directory with deterministic bounded results. Use root and include_globs/exclude_globs to narrow discovery, then read a candidate with read_file.",
        "parameters":{"type":"object","additionalProperties":false,"properties":{
            "root":{"type":"string","description":"Workspace-relative directory to inspect. Defaults to the active workspace root."},
            "include_globs":{"type":"array","items":{"type":"string"},"description":"Optional workspace-relative file globs applied during traversal."},
            "exclude_globs":{"type":"array","items":{"type":"string"},"description":"Optional workspace-relative file or directory globs excluded during traversal."},
            "max_results":{"type":"integer","minimum":1,"maximum":1000},
            "max_files":{"type":"integer","minimum":1,"maximum":50000},
            "max_dirs":{"type":"integer","minimum":1,"maximum":10000},
            "max_depth":{"type":"integer","minimum":0,"maximum":100},
            "timeout_ms":{"type":"integer","minimum":10,"maximum":30000},
            "cursor":{"type":"string"}
        }},
        "effectBoundary":"none", "concurrencySafe":true,
        "interruptBehavior":"continue", "transcriptVisibility":"visible"
    })
}

pub(super) async fn execute(
    workspace: &NativeWorkspaceFiles,
    input: CapabilityInvocation<'_>,
) -> Result<Value, CapabilityError> {
    let started = Instant::now();
    let args = match super::arguments::parse(input.call) {
        Ok(args) => args,
        Err((code, detail)) => {
            return Ok(json!({"ok":false,"error":code,"detail":detail,
                "message":"Tool arguments must be a JSON object.",
                "recovery_hint":"Retry list_files with root, include_globs, exclude_globs, max_results, or cursor fields.",
                "evidence_capability_receipts":evidence::list_limitation(code)}));
        }
    };
    let workspace_root = super::arguments::root(&input, &args)?
        .to_string_lossy()
        .into_owned();
    let root = normalize_root(args.get("root"));
    let include = match globs(&args, "include_globs", "include") {
        Ok(value) => value,
        Err((message, hint)) => return Ok(invalid_arguments(&message, &hint)),
    };
    let exclude = match globs(&args, "exclude_globs", "exclude") {
        Ok(value) => value,
        Err((message, hint)) => return Ok(invalid_arguments(&message, &hint)),
    };
    let limits = WorkspaceListLimits {
        max_results: integer(args.get("max_results"), 100, 1, 1_000)?,
        max_files: integer(args.get("max_files"), 5_000, 1, 50_000)?,
        max_dirs: integer(args.get("max_dirs"), 1_000, 1, 10_000)?,
        max_depth: integer(args.get("max_depth"), 25, 0, 100)?,
        elapsed_ms: integer(args.get("timeout_ms"), 5_000, 10, 30_000)? as u64,
    };
    let query = super::cursor::query_hash(&json!({
        "workspace_root":workspace_root, "root":root,
        "include_globs":include, "exclude_globs":exclude,
        "limits":{"maxResults":limits.max_results,"maxFiles":limits.max_files,
            "maxDirs":limits.max_dirs,"maxDepth":limits.max_depth,
            "elapsedMs":limits.elapsed_ms}
    }))
    .map_err(|_| CapabilityError {
        code: "cursor_query_json_failed".into(),
    })?;
    let cursor_input = args.get("cursor").filter(|value| {
        !value
            .as_str()
            .is_some_and(|text| crate::public_text::trim_js_whitespace(text).is_empty())
    });
    let position = cursor_input.and_then(cursor::decode);
    if cursor_input.is_some() && position.as_ref().is_none_or(|cursor| cursor.query != query) {
        return Ok(invalid_cursor(
            u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        ));
    }
    let outcome = workspace
        .list_files(WorkspaceListInput {
            root: PathBuf::from(&workspace_root),
            requested_root: root,
            relative_only: input.allowed_tools_and_effects.is_some(),
            protected_roots: input.protected_ledger_roots.to_vec(),
            include_globs: include.clone(),
            exclude_globs: exclude.clone(),
            after_path: position.map(|cursor| cursor.marker),
            include_after_path: false,
            limits,
        })
        .await
        .map_err(|error| CapabilityError {
            code: error.code.into(),
        })?
        .map_err(|_| CapabilityError {
            code: "workspace_list_io_error".into(),
        })?;
    match outcome {
        WorkspaceListOutcome::Rejected(rejection) => {
            let error = if matches!(
                rejection.reason,
                "directory_not_allowed" | "not_a_directory"
            ) {
                "not_a_directory"
            } else {
                rejection.reason
            };
            let mut result = json!({
                "ok":false, "error":error, "guard":rejection.guard,
                "message":"The discovery root is not an admitted workspace directory.",
                "recovery_hint":"Choose a contained, non-sensitive workspace directory.",
                "evidence_capability_receipts":evidence::list_limitation(error)
            });
            if let Some(path) = rejection.safe_path {
                result["path"] = json!(path);
            }
            Ok(result)
        }
        WorkspaceListOutcome::Listed(listed) => {
            let files: Vec<Value> = listed
                .files
                .into_iter()
                .map(|file| json!({"path":file.path,"bytes":file.bytes}))
                .collect();
            let truncated = listed.stopped_by.is_some();
            let marker = listed
                .last_file_path
                .as_deref()
                .or(listed.last_path.as_deref())
                .or_else(|| files.last().and_then(|file| file["path"].as_str()));
            let next_cursor = if truncated
                && matches!(listed.stopped_by, None | Some("max_results" | "max_files"))
            {
                marker.map(|path| cursor::encode(&query, path))
            } else {
                None
            };
            let mut references = json!({"root":listed.root,"include_globs":include,
                "exclude_globs":exclude,"files_considered":listed.files_considered,
                "dirs_visited":listed.dirs_visited,"io_errors":listed.io_errors,
                "truncated":truncated});
            if let Some(reason) = listed.stopped_by {
                references["stopped_by"] = json!(reason);
            }
            let mut result = json!({
                "ok":true, "root":listed.root, "files":files,
                "files_considered":listed.files_considered,
                "dirs_visited":listed.dirs_visited, "io_errors":listed.io_errors,
                "truncated":truncated,
                "metrics":{"elapsed_ms":listed.elapsed_ms.max(u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)),
                    "files_considered":listed.files_considered,
                    "files_returned":files.len(),
                    "dirs_visited":listed.dirs_visited,
                    "io_errors":listed.io_errors},
                "evidence_receipts":evidence::list_execution(
                    files.len(), next_cursor.is_some(), truncated,
                    &references),
                "evidence_capability_receipts":evidence::list_capability(
                    &files, listed.files_considered, listed.dirs_visited, truncated)
            });
            if let Some(reason) = listed.stopped_by {
                result["stopped_by"] = json!(reason);
                if !matches!(reason, "max_results" | "max_files") {
                    result["recovery_hint"] = json!(if reason == "io_error" {
                        "Discovery hit a workspace I/O error; retry list_files with a narrower admitted root or glob."
                    } else {
                        "Discovery stopped before a safe file boundary; narrow the root/globs or raise the directory/depth/time cap and retry without cursor."
                    });
                }
            }
            if let Some(cursor) = next_cursor {
                result["next_cursor"] = json!(cursor);
            }
            Ok(result)
        }
    }
}

pub(super) fn normalize_root(value: Option<&Value>) -> String {
    let Some(text) = value.and_then(Value::as_str) else {
        return ".".into();
    };
    let text = crate::public_text::trim_js_whitespace(text);
    if text.is_empty() {
        return ".".into();
    }
    let normalized = text.replace('\\', "/");
    let normalized = normalized.strip_prefix("./").unwrap_or(&normalized);
    let normalized = normalized.trim_end_matches('/');
    if normalized.is_empty() {
        ".".into()
    } else {
        normalized.into()
    }
}

pub(super) fn globs(
    args: &serde_json::Map<String, Value>,
    canonical: &str,
    legacy: &str,
) -> Result<Vec<String>, (String, String)> {
    let canonical_present = args.contains_key(canonical);
    let legacy_present = args.contains_key(legacy);
    let canonical_value = normalize_globs(args.get(canonical), canonical)?;
    let legacy_value = normalize_globs(args.get(legacy), legacy)?;
    if canonical_present && legacy_present && canonical_value != legacy_value {
        return Err((
            format!("{canonical} and replay alias {legacy} disagree after normalization."),
            format!("Provide only {canonical} with one canonical glob list."),
        ));
    }
    Ok(if canonical_present {
        canonical_value
    } else {
        legacy_value
    })
}

fn normalize_globs(value: Option<&Value>, name: &str) -> Result<Vec<String>, (String, String)> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let values = value
        .as_array()
        .filter(|values| values.iter().all(Value::is_string))
        .ok_or_else(|| {
            (
                format!("{name} must be an array of strings when supplied."),
                format!(
                    "Provide {name} as an array containing only workspace-relative glob strings."
                ),
            )
        })?;
    let mut normalized: Vec<String> = values
        .iter()
        .filter_map(Value::as_str)
        .map(|text| {
            let text = crate::public_text::trim_js_whitespace(text).replace('\\', "/");
            text.strip_prefix("./").unwrap_or(&text).to_owned()
        })
        .filter(|text| !text.is_empty())
        .collect();
    normalized.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    normalized.dedup();
    Ok(normalized)
}

pub(super) fn integer(
    value: Option<&Value>,
    fallback: usize,
    min: usize,
    max: usize,
) -> Result<usize, CapabilityError> {
    let Some(value) = value else {
        return Ok(fallback);
    };
    let number = crate::json::coerce_number(value).map_err(|_| CapabilityError {
        code: "invalid_number_conversion".into(),
    })?;
    Ok(if number.is_finite() {
        crate::json::saturating_usize(number.floor().max(min as f64).min(max as f64))
    } else {
        fallback
    })
}

fn invalid_arguments(message: &str, recovery_hint: &str) -> Value {
    json!({"ok":false,"error":"invalid_arguments","message":message,
        "recovery_hint":recovery_hint,
        "evidence_capability_receipts":evidence::list_limitation("invalid_arguments")})
}

fn invalid_cursor(elapsed_ms: u64) -> Value {
    json!({"ok":false,"error":"invalid_cursor",
        "message":"The list_files cursor is malformed or does not match the current discovery options.",
        "recovery_hint":"Restart list_files without cursor using the same root and glob filters.",
        "metrics":{"elapsed_ms":elapsed_ms},
        "evidence_capability_receipts":evidence::list_limitation("invalid_cursor")})
}
