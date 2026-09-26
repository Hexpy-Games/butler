use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::workspace::safe_workspace_path;

fn now_iso() -> String {
    DateTime::<Utc>::from(std::time::SystemTime::now())
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn receipt_id() -> String {
    format!("ecr-{}", &Uuid::new_v4().to_string()[..12])
}
fn capability_base(
    tool_name: &str,
    capability: &str,
    evidence_kind: &str,
    maturity: &str,
    verified: bool,
    confidence: f64,
    summary: &str,
) -> Value {
    json!({ "receipt_id": receipt_id(), "schema_version": "evidence-capability.v1", "producer": { "kind": "tool", "name": tool_name },
        "capability": capability, "evidence_kind": evidence_kind, "maturity": maturity, "confidence": confidence,
        "verified": verified, "summary": summary, "references": [], "limitations": [], "created_at": now_iso() })
}
pub(super) fn limitation(error: &str) -> Vec<Value> {
    let mut receipt = capability_base(
        "read_file",
        "limitation_recorded",
        "limitation",
        "rejected",
        false,
        0.7,
        "File tool execution was skipped or failed before producing verified evidence.",
    );
    receipt["scope"] = json!({ "tool": "read_file", "error": error });
    receipt["limitations"] = json!(["No file content or private path was exposed in the receipt."]);
    vec![receipt]
}
pub(super) fn read_capability(ok: bool, truncated: bool, files: &[Value]) -> Vec<Value> {
    if !ok {
        return limitation("all_files_failed");
    }
    let references: Vec<Value> = files
        .iter()
        .filter_map(|file| {
            if !file.get("ok")?.as_bool()? || file.get("skipped").is_some_and(|v| v == true) {
                return None;
            }
            let path = safe_workspace_path(file.get("path")?.as_str()?)?;
            Some(json!({ "path": path }))
        })
        .take(12)
        .collect();
    if references.is_empty() {
        let mut receipt = capability_base(
            "read_file",
            "limitation_recorded",
            "limitation",
            "rejected",
            false,
            0.7,
            "File inspection produced no safe admitted file reference for verification.",
        );
        receipt["scope"] = json!({ "tool": "read_file", "batch": true, "truncated": truncated });
        receipt["limitations"] =
            json!(["No file content or private path was exposed in the receipt."]);
        return vec![receipt];
    }
    let mut receipt = capability_base(
        "read_file",
        "source_verified",
        "workspace_inspection",
        "verified",
        true,
        if truncated { 0.75 } else { 0.95 },
        if truncated {
            "File inspection completed with bounded partial results."
        } else {
            "File inspection completed with redacted metadata."
        },
    );
    receipt["scope"] = json!({ "tool": "read_file", "batch": true, "files_requested": files.len(), "files_verified": references.len(), "truncated": truncated });
    receipt["references"] = json!(references);
    receipt["satisfies"] = json!(["source_verified"]);
    if truncated {
        receipt["limitations"] = json!(["Result was bounded and may be partial."]);
    }
    vec![receipt]
}

pub(super) fn list_limitation(error: &str) -> Vec<Value> {
    let mut receipt = capability_base(
        "list_files",
        "limitation_recorded",
        "limitation",
        "rejected",
        false,
        0.7,
        "File tool execution was skipped or failed before producing verified evidence.",
    );
    receipt["scope"] = json!({ "tool": "list_files", "error": error });
    receipt["limitations"] = json!(["No file content or private path was exposed in the receipt."]);
    vec![receipt]
}

pub(super) fn grep_limitation(error: &str) -> Vec<Value> {
    let mut receipt = capability_base(
        "grep_files",
        "limitation_recorded",
        "limitation",
        "rejected",
        false,
        0.7,
        "File tool execution was skipped or failed before producing verified evidence.",
    );
    receipt["scope"] = json!({"tool":"grep_files","error":error});
    receipt["limitations"] = json!(["No file content or private path was exposed in the receipt."]);
    vec![receipt]
}

pub(super) fn grep_capability(
    matches: &[crate::workspace::GrepMatch],
    truncated: bool,
    files_searched: usize,
    files_skipped: usize,
) -> Vec<Value> {
    let mut references = Vec::new();
    for item in matches {
        let Some(path) = safe_workspace_path(&item.path) else {
            continue;
        };
        if references.iter().any(|value: &Value| value["path"] == path) {
            continue;
        }
        references.push(json!({"path":path,"label":format!("line {}", item.line)}));
        if references.len() >= 12 {
            break;
        }
    }
    let mut receipt = capability_base(
        "grep_files",
        "source_candidate",
        "source_candidate",
        "candidate",
        false,
        if truncated { 0.35 } else { 0.5 },
        "Workspace search returned candidate file matches for later verification.",
    );
    receipt["scope"] = json!({"tool":"grep_files","truncated":truncated,
        "files_searched":files_searched,"files_skipped":files_skipped,
        "match_count":matches.len(),"candidate_count":references.len()});
    receipt["references"] = json!(references);
    receipt["limitations"] = json!(["Search candidate discovery is not source verification."]);
    vec![receipt]
}

pub(super) fn grep_execution(summary: String, references: Value) -> Vec<Value> {
    vec![json!({"schema":"butler.evidence-receipt.v1",
        "id":format!("receipt-grep_files-{}",Uuid::new_v4()),
        "producer":{"kind":"tool","name":"grep_files"},
        "receiptType":"execution","verified":true,
        "covers":["execution_result","workspace_search_result"],
        "summary":summary,"references":[references],"satisfies":[]})]
}

pub(super) fn list_capability(
    files: &[Value],
    files_considered: usize,
    dirs_visited: usize,
    truncated: bool,
) -> Vec<Value> {
    let references: Vec<Value> = files
        .iter()
        .filter_map(|file| {
            let path = safe_workspace_path(file.get("path")?.as_str()?)?;
            Some(json!({"path":path}))
        })
        .take(12)
        .collect();
    let mut receipt = capability_base(
        "list_files",
        "workspace_file_list",
        "workspace_inspection",
        "candidate",
        false,
        if truncated { 0.75 } else { 0.95 },
        "Workspace file discovery completed with bounded path metadata.",
    );
    receipt["scope"] = json!({ "tool":"list_files", "truncated":truncated,
        "files_considered":files_considered, "dirs_visited":dirs_visited,
        "file_count":files.len() });
    receipt["references"] = json!(references);
    if truncated {
        receipt["limitations"] = json!(["Discovery was bounded and may be partial."]);
    }
    vec![receipt]
}

pub(super) fn list_execution(
    count: usize,
    next_cursor: bool,
    truncated: bool,
    references: Value,
) -> Vec<Value> {
    let summary = format!(
        "Discovered {count} workspace files{}",
        if next_cursor {
            " with bounded continuation"
        } else if truncated {
            " with a bounded partial result"
        } else {
            ""
        }
    );
    vec![json!({ "schema":"butler.evidence-receipt.v1",
        "id": format!("receipt-list_files-{}", Uuid::new_v4()),
        "producer":{"kind":"tool","name":"list_files"},
        "receiptType":"execution", "verified":true,
        "covers":["execution_result","workspace_file_list"],
        "summary":summary, "references":[references], "satisfies":[] })]
}
pub(super) fn execution(
    files_read: usize,
    references: &[Value],
    truncated: bool,
    continued: bool,
) -> Vec<Value> {
    let summary = format!(
        "Read {files_read} workspace files{}",
        if continued {
            " with bounded continuation"
        } else if truncated {
            " with a bounded partial result"
        } else {
            ""
        }
    );
    vec![
        json!({ "schema": "butler.evidence-receipt.v1", "id": format!("receipt-read_file-{}", Uuid::new_v4()),
        "producer": { "kind": "tool", "name": "read_file" }, "receiptType": "execution", "verified": true,
        "covers": ["execution_result", "workspace_file_read"], "summary": summary,
        "references": [{ "files": references, "truncated": truncated }],
        "satisfies": if references.is_empty() { vec![] } else { vec!["source_verified"] } }),
    ]
}
pub(super) fn execution_references(files: &[Value]) -> Vec<Value> {
    files
        .iter()
        .filter_map(|file| {
            if !file.get("ok")?.as_bool()? || file.get("skipped").is_some_and(|v| v == true) {
                return None;
            }
            let path = safe_workspace_path(file.get("path")?.as_str()?)?;
            Some(json!({ "path": path, "bytes": file.get("bytes"), "sha256": file.get("sha256") }))
        })
        .take(12)
        .collect()
}
