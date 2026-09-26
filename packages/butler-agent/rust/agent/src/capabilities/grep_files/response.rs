use std::time::Instant;

use serde_json::{Value, json};

use crate::workspace::{WorkspaceListRejection, WorkspaceListResult};

use super::super::evidence;
use super::{args::Options, cursor::GrepCursor, search::SearchResult};

pub(super) fn invalid_cursor(elapsed_ms: u64) -> Value {
    json!({"ok":false,"error":"invalid_cursor",
        "message":"The grep_files cursor is malformed or does not match the current search options.",
        "recovery_hint":"Restart grep_files with the same pattern/root/globs and omit cursor.",
        "metrics":{"elapsed_ms":elapsed_ms},
        "evidence_capability_receipts":evidence::grep_limitation("invalid_cursor")})
}

pub(super) fn guard_rejection(root: &str, rejection: WorkspaceListRejection) -> Value {
    let error = if matches!(
        rejection.reason,
        "directory_not_allowed" | "not_a_directory"
    ) {
        "not_a_directory"
    } else {
        rejection.reason
    };
    let unsafe_root = root.starts_with('/')
        || (root.as_bytes().get(1) == Some(&b':') && root.as_bytes().get(2) == Some(&b'/'))
        || root.split(['/', '\\']).any(|segment| segment == "..");
    json!({"ok":false,"error":error,"searched_root":if unsafe_root { "." } else { root },
        "guard":rejection.guard,
        "message":"The search root is not an admitted workspace directory.",
        "recovery_hint":"Choose a contained, non-sensitive workspace directory.",
        "evidence_capability_receipts":evidence::grep_limitation(error)})
}

pub(super) fn success(
    started: Instant,
    options: &Options,
    query: &str,
    listed: &WorkspaceListResult,
    searched: SearchResult,
    cursor: Option<&GrepCursor>,
) -> Value {
    let partial: Vec<_> = searched
        .reads
        .iter()
        .filter(|candidate| {
            matches!(
                candidate.read.reason,
                Some("max_bytes_per_file" | "io_error")
            )
        })
        .collect();
    let mut partial_reasons = Vec::new();
    for reason in partial.iter().filter_map(|candidate| candidate.read.reason) {
        if !partial_reasons.contains(&reason) {
            partial_reasons.push(reason);
        }
    }
    let incomplete = !partial.is_empty();
    let files_searched = searched
        .reads
        .iter()
        .filter(|candidate| !candidate.read.skipped)
        .count();
    let files_skipped = searched.reads.len() - files_searched;
    let io_errors = listed.io_errors
        + searched
            .reads
            .iter()
            .filter(|candidate| candidate.read.reason == Some("io_error"))
            .count();
    let binary_files = searched
        .reads
        .iter()
        .filter(|candidate| candidate.read.reason == Some("binary"))
        .count();
    let invalid_utf8_files = searched
        .reads
        .iter()
        .filter(|candidate| candidate.read.reason == Some("invalid_utf8"))
        .count();
    let truncated = listed.stopped_by.is_some()
        || searched.max_matches_reached
        || searched.max_output_reached
        || searched.stopped_within_candidate
        || searched.elapsed_budget_reached;
    let stopped_by = if searched.elapsed_budget_reached {
        Some("elapsed_ms")
    } else if searched.max_output_reached {
        Some("max_output_bytes")
    } else if searched.max_matches_reached {
        Some("max_results")
    } else if incomplete && listed.stopped_by.is_none() {
        Some(if partial_reasons.contains(&"io_error") {
            "io_error"
        } else {
            "max_bytes_per_file"
        })
    } else {
        listed.stopped_by
    };
    let supports_cursor = !searched.elapsed_budget_reached
        && matches!(listed.stopped_by, None | Some("max_results" | "max_files"));
    let last_match = searched.matches.last();
    let after = cursor.and_then(|cursor| cursor.marker.as_deref().zip(cursor.line));
    let scan_path = listed
        .last_file_path
        .as_deref()
        .or(searched.processed_candidate.as_deref())
        .or(listed.last_path.as_deref());
    let window_marker = last_match
        .map(|item| (item.path.as_str(), item.line))
        .or(after)
        .filter(|_| supports_cursor && searched.stopped_within_candidate);
    let next_cursor = if let Some((marker, line)) = window_marker {
        searched
            .window_start
            .as_ref()
            .zip(searched.window_end.as_ref())
            .map(|(start, end)| {
                super::cursor::encode(&GrepCursor {
                    query: query.into(),
                    scan_path: start.clone(),
                    inclusive: true,
                    marker: Some(marker.into()),
                    line: Some(line),
                    window_start: Some(start.clone()),
                    window_end: Some(end.clone()),
                })
            })
    } else if supports_cursor
        && listed.stopped_by.is_some()
        && !searched.max_output_reached
        && (!searched.max_matches_reached || !searched.stopped_within_candidate)
    {
        scan_path.map(|path| {
            super::cursor::encode(&GrepCursor {
                query: query.into(),
                scan_path: path.into(),
                inclusive: false,
                marker: None,
                line: None,
                window_start: None,
                window_end: None,
            })
        })
    } else {
        None
    };
    let metrics = json!({
        "elapsed_ms":started.elapsed().as_millis() as u64,
        "files_considered":listed.files_considered,"files_searched":files_searched,
        "files_skipped":files_skipped,
        "candidate_reads":searched.reads.iter().filter(|candidate| candidate.read.attempted_read).count(),
        "oversized_files":searched.reads.iter().filter(|candidate| candidate.read.reason == Some("max_bytes_per_file")).count(),
        "candidate_io_errors":searched.reads.iter().filter(|candidate| candidate.read.reason == Some("io_error")).count(),
        "io_errors":io_errors,"binary_files":binary_files,"invalid_utf8_files":invalid_utf8_files,
        "bytes_read":searched.reads.iter().map(|candidate| candidate.read.bytes_read).sum::<usize>(),
        "output_bytes":searched.output_bytes,"read_concurrency":4
    });
    let mut receipt_references = json!({"searched_root":listed.root,"pattern":options.pattern,
        "regex":options.regex,"case_sensitive":options.case_sensitive,
        "include_globs":options.include,"exclude_globs":options.exclude,
        "files_searched":files_searched,"files_skipped":files_skipped,
        "binary_files":binary_files,"invalid_utf8_files":invalid_utf8_files,
        "dirs_visited":listed.dirs_visited,"files_considered":listed.files_considered,
        "io_errors":io_errors,"output_bytes":searched.output_bytes,
        "truncated":truncated || incomplete});
    if let Some(reason) = stopped_by {
        receipt_references["stopped_by"] = json!(reason);
    }
    let mut result = json!({
        "ok":true,"searched_root":listed.root,"pattern":options.pattern,"regex":options.regex,
        "case_sensitive":options.case_sensitive,"include_globs":options.include,"exclude_globs":options.exclude,
        "files_searched":files_searched,"files_skipped":files_skipped,"binary_files":binary_files,
        "invalid_utf8_files":invalid_utf8_files,"io_errors":io_errors,
        "dirs_visited":listed.dirs_visited,"files_considered":listed.files_considered,
        "matches":searched.matches,"output_bytes":searched.output_bytes,
        "max_output_bytes":options.max_output_bytes,"output_truncated":searched.max_output_reached,
        "truncated":truncated || incomplete,"metrics":metrics,
        "evidence_receipts":evidence::grep_execution(
            format!("Found {} matches for {}{}", searched.matches.len(), options.pattern,
                if next_cursor.is_some() { " with bounded continuation" }
                else if truncated || incomplete { " with a bounded partial result" } else { "" }),
            receipt_references),
        "evidence_capability_receipts":evidence::grep_capability(&searched.matches,
            truncated || incomplete, files_searched, files_skipped)
    });
    if incomplete {
        result["partial"] = json!(true);
        result["partial_reasons"] = json!(partial_reasons);
        result["unsearched_files"] = json!(
            partial
                .iter()
                .map(|candidate| { json!({"path":candidate.path,"reason":candidate.read.reason}) })
                .collect::<Vec<_>>()
        );
    }
    if let Some(reason) = stopped_by {
        result["stopped_by"] = json!(reason);
    }
    if searched.elapsed_budget_reached {
        result["recovery_hint"] = json!(
            "Search reached its time budget before all candidate files were read; narrow the root or globs and retry without cursor."
        );
    } else if incomplete {
        result["recovery_hint"] = json!(if partial_reasons.contains(&"io_error") {
            "Search encountered a candidate I/O error; inspect unsearched_files and check workspace permissions."
        } else {
            "Some candidates exceeded max_bytes_per_file; read relevant unsearched_files with read_file using line ranges."
        });
    } else if listed.stopped_by.is_some() && !supports_cursor {
        result["recovery_hint"] = json!(if listed.stopped_by == Some("io_error") {
            "Search hit a workspace I/O error; retry grep_files with a narrower admitted root or glob."
        } else {
            "Search stopped before a safe file boundary; narrow the root/globs and retry without cursor."
        });
    }
    if let Some(cursor) = next_cursor {
        result["next_cursor"] = json!(cursor);
    }
    result
}
