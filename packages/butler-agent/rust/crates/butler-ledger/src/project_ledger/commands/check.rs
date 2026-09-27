//! Project Ledger check: source validation, derived warnings, and privacy scan.

use std::fs;
use std::path::Path;
use std::sync::LazyLock;

use regex::{RegexSet, RegexSetBuilder};
use serde_json::{Value, json};

use butler_core::locale::LocaleCollation;

use super::{CliFailure, CommandContext, display_path, index, io_failure, option_string};

#[expect(
    clippy::expect_used,
    reason = "fixed source patterns; the wire_formats golden check runs this set"
)]
static PRIVATE_PATTERNS: LazyLock<RegexSet> = LazyLock::new(|| {
    RegexSetBuilder::new([
        r"OPENAI_API_KEY\s*=",
        r"BEGIN PRIVATE TRANSCRIPT",
        r"rawTranscript\s*[:=]",
        r"private transcript",
        r"authorization:\s*bearer",
        r"AWS_SECRET_ACCESS_KEY\s*=",
        r"BEGIN RSA PRIVATE KEY",
    ])
    .case_insensitive(true)
    .build()
    .expect("source privacy patterns compile")
});

/// Every issue the index, generated views and privacy scan raise; any issue
/// fails the check with the issue list as its data.
pub(super) fn check(
    context: &CommandContext,
    options: &Value,
    _collation: &LocaleCollation,
) -> Result<Value, CliFailure> {
    let root = &context.root;
    let index_available = root.join("index/project.json").exists();
    let index = index::build(root)?;
    let mut issues = index_issues(root, &index, index_available);
    scan_privacy(root, &mut issues)?;
    let issue_count = issues.len();
    let error_count = issues
        .iter()
        .filter(|issue| issue.get("severity").and_then(Value::as_str) == Some("error"))
        .count();
    let warning_count = issue_count - error_count;
    let data = json!({"ok":issue_count==0,"issueCount":issue_count,"issues":issues,"counts":index.get("counts")});
    if issue_count == 0 {
        return Ok(data);
    }
    let project_flag = option_string(options, "project")
        .filter(|value| !value.is_empty())
        .map(|value| format!(" --project {value}"))
        .unwrap_or_default();
    let mut failure = CliFailure::new(
        "project_ledger_check_failed",
        format!(
            "Project Ledger check failed with {issue_count} issue{}",
            if issue_count == 1 { "" } else { "s" }
        ),
    );
    failure.data = Box::new(data);
    failure.details = Box::new(
        json!([{"issueCount":issue_count,"errorCount":error_count,"warningCount":warning_count}]),
    );
    failure.next = vec![
        json!({"command":format!("project-ledger check{project_flag} --verbose"),"reason":"Inspect the full issue list before retrying."}),
        json!({"command":format!("project-ledger index{project_flag}"),"reason":"Refresh the derived index after source-record repairs."}),
    ];
    Err(failure)
}

/// The index's own issues, led by a missing or stale index and followed by
/// stale or missing generated views.
fn index_issues(root: &Path, index: &Value, index_available: bool) -> Vec<Value> {
    let mut issues = index
        .get("issues")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !index_available {
        issues.insert(
            0,
            issue(
                "missing_index",
                "Index has not been written yet",
                "index/project.json",
                root,
            ),
        );
    } else if index.pointer("/index/stale").and_then(Value::as_bool) == Some(true) {
        issues.insert(
            0,
            issue(
                "stale_index",
                "Index is older than source records",
                "index/project.json",
                root,
            ),
        );
    }
    let views = index
        .get("views")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    for view in views {
        if view.get("stale").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        let exists = view.get("exists").and_then(Value::as_bool) == Some(true);
        issues.push(json!({
            "code":"stale_view","severity":"warning",
            "message":if exists {"Generated view is older than source records"} else {"Generated view is missing"},
            "path":view.get("path"),"record":null,
        }));
    }
    issues
}

fn issue(code: &str, message: &str, relative: &str, root: &Path) -> Value {
    json!({"code":code,"severity":"warning","message":message,
        "path":display_path(root,Path::new(relative)),"record":null})
}

fn scan_privacy(root: &Path, issues: &mut Vec<Value>) -> Result<(), CliFailure> {
    scan_directory(root, root, issues)
}

fn scan_directory(
    root: &Path,
    directory: &Path,
    issues: &mut Vec<Value>,
) -> Result<(), CliFailure> {
    for entry in fs::read_dir(directory).map_err(|source| io_failure().with_source(source))? {
        let entry = entry.map_err(|source| io_failure().with_source(source))?;
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        // Source listFiles uses statSync, including followed symlink targets.
        let metadata = fs::metadata(&path).map_err(|source| io_failure().with_source(source))?;
        if metadata.is_dir() {
            if name != "index" && name != "views" {
                scan_directory(root, &path, issues)?;
            }
        } else if metadata.is_file()
            && name != "ledger.jsonl"
            && name != ".DS_Store"
            && name != "github-issues.json"
        {
            let text =
                fs::read_to_string(&path).map_err(|source| io_failure().with_source(source))?;
            if PRIVATE_PATTERNS.is_match(&text) {
                let relative = path
                    .strip_prefix(root)
                    .map_err(|source| io_failure().with_source(source))?;
                issues.push(json!({
                    "code":"possible_private_content","severity":"error",
                    "message":"Record may contain private content; inspect locally without copying raw text.",
                    "path":display_path(root,relative),"record":null,
                }));
            }
        }
    }
    Ok(())
}
