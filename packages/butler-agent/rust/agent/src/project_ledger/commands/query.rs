//! Source query families over the compact Project Ledger index.

use std::cmp::Ordering;

use serde_json::{Value, json};

use crate::locale::LocaleCollation;

use super::{CliFailure, CommandContext, index, option_string, record};

const RECORD_KINDS: &[&str] = &[
    "all",
    "initiative",
    "decision",
    "risk",
    "spec",
    "report",
    "plan",
    "handoff",
    "reference",
    "roadmap",
    "work",
    "task",
    "attempt",
];
const DERIVED_KINDS: &[&str] = &[
    "next-actions",
    "blocked",
    "review",
    "missing-spec",
    "completion-gaps",
    "stale-view",
    "stale-index",
    "decision-without-implementation",
    "risk-without-mitigation",
    "recent-completed",
];

pub(super) fn query(
    context: &CommandContext,
    options: &Value,
    collation: &LocaleCollation,
) -> Result<Value, CliFailure> {
    let kind = option_string(options, "kind")
        .filter(|kind| !kind.is_empty())
        .ok_or_else(|| CliFailure::new("invalid_arguments", "Missing required option: --kind"))?;
    let index = index::load(&context.root, collation)?;
    let rows = select(&index, kind, options, collation)?;
    let status = option_string(options, "status").filter(|value| !value.is_empty());
    let needle = option_string(options, "query")
        .map(crate::public_text::trim_js_whitespace)
        .unwrap_or("")
        .to_lowercase();
    let rows = rows
        .as_array()
        .ok_or_else(|| CliFailure::new("internal_error", "Invalid Project Ledger query"))?;
    let filtered = rows
        .iter()
        .filter(|record| {
            status.is_none_or(|status| record.get("status").and_then(Value::as_str) == Some(status))
        })
        .filter(|record| {
            needle.is_empty()
                || crate::json::stringify(record)
                    .is_ok_and(|text| text.to_lowercase().contains(&needle))
        })
        .cloned()
        .collect::<Vec<_>>();
    let Some(raw_limit) = options.get("limit") else {
        return Ok(json!({"kind":kind,"results":filtered}));
    };
    let limit = crate::json::saturating_usize(
        match raw_limit {
            Value::String(raw) => raw.parse::<f64>().ok(),
            Value::Number(number) => number.as_f64(),
            _ => None,
        }
        .filter(|value| value.fract() == 0.0 && (1.0..=1000.0).contains(value))
        .ok_or_else(|| {
            CliFailure::new(
                "invalid_arguments",
                "limit must be an integer between 1 and 1000",
            )
        })?,
    );
    let total = filtered.len();
    Ok(json!({
        "kind":kind,
        "results":filtered.into_iter().take(limit).collect::<Vec<_>>(),
        "limit":limit,
        "returned":total.min(limit),
        "total":total,
        "truncated":total>limit,
    }))
}

pub(super) fn select(
    index: &Value,
    kind: &str,
    options: &Value,
    collation: &LocaleCollation,
) -> Result<Value, CliFailure> {
    if !RECORD_KINDS.contains(&kind) && !DERIVED_KINDS.contains(&kind) {
        return Err(CliFailure::new(
            "invalid_query_kind",
            format!("Unsupported query kind: {kind}"),
        ));
    }
    let records = index
        .get("records")
        .and_then(Value::as_array)
        .ok_or_else(|| CliFailure::new("internal_error", "Invalid Project Ledger index records"))?;
    let mut rows = records
        .iter()
        .filter(|record| text(record, "kind") != "project")
        .cloned()
        .collect::<Vec<_>>();
    let issue_rows = index
        .get("issues")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let selected = match kind {
        "next-actions" => {
            rows.retain(|record| {
                matches!(text(record, "kind"), "work" | "task")
                    && matches!(
                        text(record, "status"),
                        "proposed" | "scoped" | "specified" | "in_progress" | "todo"
                    )
            });
            sort_records(&mut rows, collation);
            rows.into_iter()
                .map(|record| record::reference(&record, Some("active_next_action")))
                .collect()
        }
        "blocked" | "review" => {
            rows.retain(|record| text(record, "status") == kind);
            sort_records(&mut rows, collation);
            let reason = if kind == "blocked" {
                "blocked"
            } else {
                "review_ready"
            };
            rows.into_iter()
                .map(|record| record::reference(&record, Some(reason)))
                .collect()
        }
        "missing-spec" | "completion-gaps" => {
            let code = if kind == "missing-spec" {
                "missing_spec"
            } else {
                "completion_gate"
            };
            issue_rows
                .iter()
                .filter(|issue| text(issue, "code") == code)
                .filter_map(|issue| {
                    issue
                        .get("record")
                        .filter(|record| !record.is_null())
                        .map(|record| {
                            let mut row = record.clone();
                            row["reason"] = issue.get("message").cloned().unwrap_or(Value::Null);
                            row
                        })
                })
                .collect()
        }
        "stale-view" => index
            .get("views")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[])
            .iter()
            .filter(|view| view.get("stale").and_then(Value::as_bool) == Some(true))
            .map(|view| {
                let name = text(view, "name");
                let exists = view.get("exists").and_then(Value::as_bool) == Some(true);
                json!({"id":name,"kind":"view","title":format!("{name} view"),
                    "status":if exists {"stale"} else {"missing"},"path":view.get("path"),
                    "reason":if exists {"generated_view_stale"} else {"generated_view_missing"}})
            })
            .collect(),
        "stale-index" => {
            let observed = index.get("index").unwrap_or(&Value::Null);
            if observed.get("stale").and_then(Value::as_bool) == Some(true) {
                let available = observed.get("available").and_then(Value::as_bool) == Some(true);
                vec![
                    json!({"id":"project-index","kind":"index","title":"Project Ledger compact index",
                    "status":if available {"stale"} else {"missing"},
                    "path":observed.get("path").cloned().unwrap_or_else(||json!("index/project.json")),
                    "reason":if available {"compact_index_stale"} else {"compact_index_missing"}}),
                ]
            } else {
                Vec::new()
            }
        }
        "decision-without-implementation" | "risk-without-mitigation" | "recent-completed" => {
            rows.retain(|record| match kind {
                "decision-without-implementation" => {
                    text(record, "kind") == "decision" && !truthy(record.get("implementation"))
                }
                "risk-without-mitigation" => {
                    text(record, "kind") == "risk"
                        && text(record, "status") != "closed"
                        && !truthy(record.get("mitigation"))
                }
                _ => text(record, "status") == "done",
            });
            sort_records(&mut rows, collation);
            let reason = match kind {
                "decision-without-implementation" => "decision_without_implementation",
                "risk-without-mitigation" => "risk_without_mitigation",
                _ => "recent_completed",
            };
            rows.into_iter()
                .map(|record| record::reference(&record, Some(reason)))
                .collect()
        }
        _ => {
            let status = option_string(options, "status")
                .map(crate::public_text::trim_js_whitespace)
                .filter(|value| !value.is_empty());
            rows.retain(|record| {
                (kind == "all" || text(record, "kind") == kind)
                    && status.is_none_or(|status| text(record, "status") == status)
            });
            sort_records(&mut rows, collation);
            rows.into_iter()
                .map(|record| record::reference(&record, None))
                .collect()
        }
    };
    Ok(Value::Array(selected))
}

pub(super) fn sort_records(rows: &mut [Value], collation: &LocaleCollation) {
    rows.sort_by(|left, right| {
        let left_priority = left
            .get("priority")
            .and_then(Value::as_f64)
            .unwrap_or(100.0);
        let right_priority = right
            .get("priority")
            .and_then(Value::as_f64)
            .unwrap_or(100.0);
        left_priority
            .partial_cmp(&right_priority)
            .unwrap_or(Ordering::Equal)
            .then_with(|| collation.compare(text(right, "updatedAt"), text(left, "updatedAt")))
            .then_with(|| collation.compare(text(left, "id"), text(right, "id")))
    });
}

fn text<'a>(record: &'a Value, field: &str) -> &'a str {
    record.get(field).and_then(Value::as_str).unwrap_or("")
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null | Value::Bool(false)) => false,
        Some(Value::String(value)) => !value.is_empty(),
        Some(Value::Number(value)) => value.as_f64().is_some_and(|value| value != 0.0),
        _ => true,
    }
}
