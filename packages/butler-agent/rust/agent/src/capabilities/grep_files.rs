//! Source-shaped bounded workspace search.

mod args;
mod cursor;
mod response;
mod search;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use regress::{Flags, Regex};
use serde_json::{Value, json};

use super::{CapabilityError, CapabilityInvocation, arguments, evidence};
use crate::workspace::{NativeWorkspaceFiles, WorkspaceListInput, WorkspaceListOutcome};

pub(super) fn definition() -> Value {
    json!({
        "type":"function", "name":"grep_files",
        "description":"Search UTF-8 workspace text with a regular expression (literal=false), or exact text (literal=true). Use root and include_globs/exclude_globs to narrow discovery; continue with the returned next_cursor when present. Runtime owns traversal and output budgets.",
        "parameters":{"type":"object","additionalProperties":false,"properties":{
            "pattern":{"type":"string","description":"Pattern searched inside the active workspace; paths and globs are workspace-relative."},
            "root":{"type":"string","description":"Workspace-relative directory to search. Defaults to the active workspace root."},
            "literal":{"type":"boolean","description":"Use false for regular expressions such as foo|bar; true to match the pattern as exact text."},
            "case_sensitive":{"type":"boolean"},
            "include_globs":{"type":"array","items":{"type":"string"}},
            "exclude_globs":{"type":"array","items":{"type":"string"}},
            "context_lines":{"type":"integer","minimum":0,"maximum":10},
            "max_matches":{"type":"integer","minimum":1,"maximum":1000},
            "cursor":{"type":"string"}},"required":["pattern","literal"]},
        "effectBoundary":"none","concurrencySafe":true,
        "interruptBehavior":"continue","transcriptVisibility":"visible"
    })
}

fn escape_literal(pattern: &str) -> String {
    let mut escaped = String::with_capacity(pattern.len());
    for character in pattern.chars() {
        if ".*+?^${}()|[]\\".contains(character) {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

pub(super) async fn execute(
    workspace: &NativeWorkspaceFiles,
    input: CapabilityInvocation<'_>,
) -> Result<Value, CapabilityError> {
    let started = Instant::now();
    let args = match arguments::parse(input.call) {
        Ok(args) => args,
        Err((code, detail)) => {
            return Ok(json!({"ok":false,"error":code,"detail":detail,
            "message":"Tool arguments must be a JSON object.",
            "recovery_hint":"Retry grep_files with pattern and bounded root/glob options.",
            "evidence_capability_receipts":evidence::grep_limitation(code)}));
        }
    };
    let workspace_root = arguments::root(&input, &args)?
        .to_string_lossy()
        .into_owned();
    let options = match args::normalize(&args) {
        Ok(options) => options,
        Err(failure) => return Ok(failure),
    };
    if options.pattern.is_empty() {
        return Ok(
            json!({"ok":false,"error":"missing_pattern","message":"pattern is required.",
            "recovery_hint":"Provide a non-empty literal pattern or explicit regex pattern.",
            "evidence_capability_receipts":evidence::grep_limitation("missing_pattern")}),
        );
    }
    let query = super::cursor::query_hash(&json!({
        "workspace_root":workspace_root,"root":options.root,"pattern":options.pattern,
        "regex":options.regex,"case_sensitive":options.case_sensitive,
        "include_globs":options.include,"exclude_globs":options.exclude,
        "context_lines":options.context_lines,"max_matches":options.max_matches,
        "max_bytes_per_file":options.max_bytes_per_file,"max_output_bytes":options.max_output_bytes,
        "limits":{"maxResults":options.limits.max_results,"maxFiles":options.limits.max_files,
            "maxDirs":options.limits.max_dirs,"maxDepth":options.limits.max_depth,
            "elapsedMs":options.limits.elapsed_ms}
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
        return Ok(response::invalid_cursor(
            started.elapsed().as_millis() as u64
        ));
    }
    let deadline = started + Duration::from_millis(options.limits.elapsed_ms);
    let outcome = workspace
        .list_files(WorkspaceListInput {
            root: PathBuf::from(&workspace_root),
            requested_root: options.root.clone(),
            relative_only: input.allowed_tools_and_effects.is_some(),
            protected_roots: input.protected_ledger_roots.to_vec(),
            include_globs: options.include.clone(),
            exclude_globs: options.exclude.clone(),
            after_path: position.as_ref().map(|cursor| cursor.scan_path.clone()),
            include_after_path: position.as_ref().is_some_and(|cursor| cursor.inclusive),
            limits: options.limits,
        })
        .await
        .map_err(|error| CapabilityError {
            code: error.code.into(),
        })?
        .map_err(|_| CapabilityError {
            code: "workspace_grep_io_error".into(),
        })?;
    let listed = match outcome {
        WorkspaceListOutcome::Listed(listed) => listed,
        WorkspaceListOutcome::Rejected(rejection) => {
            return Ok(response::guard_rejection(&options.root, rejection));
        }
    };
    let matcher_source = if options.regex {
        options.pattern.clone()
    } else {
        escape_literal(&options.pattern)
    };
    let flags = Flags {
        icase: !options.case_sensitive,
        ..Flags::default()
    };
    let matcher = match Regex::with_flags(&matcher_source, flags) {
        Ok(matcher) => Arc::new(matcher),
        Err(error) => {
            return Ok(
                json!({"ok":false,"error":"invalid_pattern","detail":error.to_string(),
            "message":"The requested search pattern is not valid.",
            "recovery_hint":"Fix the regex or use literal=true for exact text.",
            "evidence_capability_receipts":evidence::grep_limitation("invalid_pattern")}),
            );
        }
    };
    let searched = search::execute(
        workspace,
        PathBuf::from(&workspace_root),
        &listed,
        matcher,
        &options,
        position.as_ref(),
        deadline,
    )
    .await?;
    Ok(response::success(
        started,
        &options,
        &query,
        &listed,
        searched,
        position.as_ref(),
    ))
}

pub(super) fn utf8_prefix_end(text: &str, max_bytes: usize) -> usize {
    crate::workspace::utf8_prefix_end(text, max_bytes)
}
