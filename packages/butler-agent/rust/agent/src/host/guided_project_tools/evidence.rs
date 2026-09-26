//! Public Project Ledger evidence attached after native command execution.

use std::path::{Component, Path, PathBuf};

use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::public_text::trim_js_whitespace;

pub(super) fn attach(
    name: &str,
    args: &Map<String, Value>,
    project_root: &Path,
    result: Value,
) -> Value {
    match name {
        "get_work_dashboard" => {
            let mut result = result;
            result["evidence_capability_receipts"] = json!([capability(CapabilitySpec {
                producer_kind: "tool",
                producer_name: name,
                name: "source_verified",
                evidence_kind: "project_state",
                confidence: 0.9,
                summary: "Canonical Butler work dashboard state was inspected.",
                scope: &Map::new(),
                references: json!([{"task_id":"work-dashboard"}]),
                satisfies: Some("source_verified"),
            })]);
            result
        }
        "project_ledger_show" => canonical_record(result),
        "inspect_project_status" => shared_source(
            result,
            "inspect_project_status",
            "Canonical Project Ledger status was inspected.",
            "project-ledger-status".into(),
        ),
        "query_project_work" => {
            let kind = text(args, "kind");
            shared_source(
                result,
                "query_project_work",
                &format!("Canonical Project Ledger {kind} query results were inspected."),
                format!("project-ledger-query:{kind}"),
            )
        }
        "project_ledger_render" | "render_project_dashboard" => {
            rendered_view(args, project_root, result)
        }
        _ => result,
    }
}

fn canonical_record(mut result: Value) -> Value {
    if result.get("ok") != Some(&Value::Bool(true)) {
        return result;
    }
    let Some(record) = result.get("data").and_then(Value::as_object) else {
        return result;
    };
    let Some(id) = record
        .get("id")
        .and_then(Value::as_str)
        .and_then(safe_identity)
    else {
        return result;
    };
    let Some(kind) = record
        .get("kind")
        .and_then(Value::as_str)
        .and_then(safe_identity)
    else {
        return result;
    };
    let status = record
        .get("status")
        .and_then(Value::as_str)
        .and_then(safe_identity);
    let mut scope = Map::new();
    scope.insert("record_id".into(), id.into());
    scope.insert("record_kind".into(), kind.into());
    if let Some(status) = status {
        scope.insert("status".into(), status.into());
    }
    let references = json!([{"label":format!("{kind}:{id}")}]);
    let mut receipts = vec![capability(CapabilitySpec {
        producer_kind: "project_ledger",
        producer_name: "project_ledger_show",
        name: "source_verified",
        evidence_kind: "project_state",
        confidence: 0.95,
        summary: "A canonical Project Ledger record was inspected.",
        scope: &scope,
        references: references.clone(),
        satisfies: Some("source_verified"),
    })];
    if kind == "work" && status == Some("done") {
        if has_text(record.get("implementation")) && has_commit_evidence(record.get("codeCommits"))
        {
            receipts.push(field_capability(
                &scope,
                references.clone(),
                "workspace_mutated",
                "mutation_result",
                "The canonical work record contains implementation and commit evidence.",
                "implementation_and_code_commits",
            ));
        }
        for (field, name, evidence_kind, summary) in [
            (
                "validation",
                "validation_passed",
                "execution_result",
                "The canonical work record contains validation evidence.",
            ),
            (
                "review",
                "review_completed",
                "review_result",
                "The canonical work record contains review evidence.",
            ),
        ] {
            if has_text(record.get(field)) {
                receipts.push(field_capability(
                    &scope,
                    references.clone(),
                    name,
                    evidence_kind,
                    summary,
                    field,
                ));
            }
        }
    }
    if let Some(output) = result.as_object_mut() {
        output.insert(
            "evidence_capability_receipts".into(),
            Value::Array(receipts),
        );
    }
    result
}

fn field_capability(
    scope: &Map<String, Value>,
    references: Value,
    name: &str,
    evidence_kind: &str,
    summary: &str,
    field: &str,
) -> Value {
    let mut scope = scope.clone();
    scope.insert("evidence_field".into(), field.into());
    capability(CapabilitySpec {
        producer_kind: "project_ledger",
        producer_name: "project_ledger_show",
        name,
        evidence_kind,
        confidence: 0.9,
        summary,
        scope: &scope,
        references,
        satisfies: None,
    })
}

fn shared_source(mut result: Value, tool: &str, summary: &str, task_id: String) -> Value {
    let Some(object) = result.as_object_mut() else {
        return result;
    };
    if !object.get("command").is_some_and(Value::is_string)
        || !object.get("privacy").is_some_and(Value::is_object)
        || object
            .get("data")
            .and_then(Value::as_object)
            .and_then(|data| data.get("initialized"))
            == Some(&Value::Bool(false))
    {
        return result;
    }
    object.insert(
        "evidence_capability_receipts".into(),
        Value::Array(vec![capability(CapabilitySpec {
            producer_kind: "tool",
            producer_name: tool,
            name: "source_verified",
            evidence_kind: "project_state",
            confidence: 0.9,
            summary,
            scope: &Map::new(),
            references: json!([{"task_id":task_id}]),
            satisfies: Some("source_verified"),
        })]),
    );
    result
}

fn rendered_view(args: &Map<String, Value>, project_root: &Path, mut result: Value) -> Value {
    if args.get("write") != Some(&Value::Bool(true))
        || result.get("ok") == Some(&Value::Bool(false))
    {
        return result;
    }
    let Some(data) = result.get("data").and_then(Value::as_object) else {
        return result;
    };
    if data.get("written") != Some(&Value::Bool(true)) {
        return result;
    }
    let Some(relative) = data
        .get("path")
        .and_then(Value::as_str)
        .map(trim_js_whitespace)
        .filter(|path| !path.is_empty())
    else {
        return result;
    };
    let relative = relative.to_owned();
    let artifact_path = artifact_path(project_root, &relative);
    let label = relative.replace('\\', "/");
    let basename = Path::new(&label)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy();
    let Some(output) = result.as_object_mut() else {
        return result;
    };
    output.insert("durable_artifact_created".into(), Value::Bool(true));
    output.insert("artifact_kind".into(), "markdown_file".into());
    output.insert("artifact_label".into(), relative.clone().into());
    output.insert(
        "artifact_path".into(),
        artifact_path.to_string_lossy().into_owned().into(),
    );
    output.insert("evidence_receipts".into(), json!([{
        "schema":"butler.evidence-receipt.v1",
        "id":format!("receipt-render_project_dashboard-{}",Uuid::new_v4()),
        "producer":{"kind":"tool","name":"render_project_dashboard"},
        "receiptType":"artifact","verified":true,
        "covers":["project_ledger_view","durable_artifact"],
        "summary":"Project Ledger generated view was written as a durable markdown artifact.",
        "references":[{"kind":"project_document","ref":&relative,"label":basename}],
        "artifacts":[{"label":&relative,"path":artifact_path.to_string_lossy(),"mediaType":"text/markdown","role":"project_ledger_view"}],
        "satisfies":["durable_artifact"]
    }]));
    output.insert(
        "verified_output_files".into(),
        json!([{"path":&relative,"artifact_kind":"markdown_file"}]),
    );
    result
}

fn artifact_path(project_root: &Path, relative: &str) -> PathBuf {
    let normalized = relative.replace('\\', "/");
    let joined = if normalized == "project-ledger" || normalized.starts_with("project-ledger/") {
        project_root
            .ancestors()
            .nth(3)
            .unwrap_or(project_root)
            .join(normalized)
    } else {
        project_root.join(normalized)
    };
    let mut resolved = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                resolved.pop();
            }
            _ => resolved.push(component.as_os_str()),
        }
    }
    resolved
}

struct CapabilitySpec<'a> {
    producer_kind: &'a str,
    producer_name: &'a str,
    name: &'a str,
    evidence_kind: &'a str,
    confidence: f64,
    summary: &'a str,
    scope: &'a Map<String, Value>,
    references: Value,
    satisfies: Option<&'a str>,
}

fn capability(spec: CapabilitySpec<'_>) -> Value {
    let CapabilitySpec {
        producer_kind,
        producer_name,
        name,
        evidence_kind,
        confidence,
        summary,
        scope,
        references,
        satisfies,
    } = spec;
    let timestamp = DateTime::<Utc>::from(std::time::SystemTime::now())
        .to_rfc3339_opts(SecondsFormat::Millis, true);
    let mut value = json!({
        "receipt_id":format!("ecr-{}", &Uuid::new_v4().to_string()[..12]),
        "schema_version":"evidence-capability.v1",
        "producer":{"kind":producer_kind,"name":producer_name},
        "capability":name,"evidence_kind":evidence_kind,"maturity":"verified",
        "confidence":confidence,"verified":true,"summary":summary,
        "references":references,"limitations":[],"created_at":timestamp
    });
    if !scope.is_empty() {
        value["scope"] = Value::Object(scope.clone());
    }
    if let Some(satisfies) = satisfies {
        value["satisfies"] = json!([satisfies]);
    }
    value
}

fn safe_identity(value: &str) -> Option<&str> {
    let value = trim_js_whitespace(value);
    (!value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')))
    .then_some(value)
}

fn has_text(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|value| !trim_js_whitespace(value).is_empty())
}

fn has_commit_evidence(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Array(items)) => items.iter().any(commit_record),
        Some(Value::String(text)) if !trim_js_whitespace(text).is_empty() => {
            match serde_json::from_str::<Value>(text) {
                Ok(Value::Array(items)) => return items.iter().any(commit_record),
                Ok(_) => return false,
                Err(_) => {}
            }
            hex_hash(trim_js_whitespace(text))
        }
        _ => false,
    }
}

fn commit_record(value: &Value) -> bool {
    value
        .get("hash")
        .and_then(Value::as_str)
        .is_some_and(|hash| hex_hash(trim_js_whitespace(hash)))
}

fn hex_hash(value: &str) -> bool {
    (7..=64).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn text<'a>(args: &'a Map<String, Value>, key: &str) -> &'a str {
    args.get(key)
        .and_then(Value::as_str)
        .map(trim_js_whitespace)
        .unwrap_or("")
}
