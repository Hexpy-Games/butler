use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::workspace::safe_workspace_path;

fn now() -> String {
    DateTime::<Utc>::from(std::time::SystemTime::now()).to_rfc3339_opts(SecondsFormat::Millis, true)
}

struct Receipt<'a> {
    tool: &'a str,
    capability: &'a str,
    kind: &'a str,
    maturity: &'a str,
    verified: bool,
    confidence: f64,
    summary: &'a str,
    scope: Value,
    references: Vec<Value>,
    satisfies: Option<Vec<&'a str>>,
    limitations: Vec<&'a str>,
}

fn capability(receipt: Receipt<'_>) -> Value {
    let Receipt {
        tool,
        capability,
        kind,
        maturity,
        verified,
        confidence,
        summary,
        scope,
        references,
        satisfies,
        limitations,
    } = receipt;
    let mut receipt = json!({
        "receipt_id": format!("ecr-{}", &Uuid::new_v4().to_string()[..12]),
        "schema_version": "evidence-capability.v1",
        "producer": {"kind":"tool", "name":tool},
        "capability":capability, "evidence_kind":kind, "maturity":maturity,
        "confidence":if confidence == 1.0 { json!(1) } else { json!(confidence) },
        "verified":verified, "summary":summary,
        "scope":scope, "references":references, "limitations":limitations,
        "created_at":now(),
    });
    if let Some(satisfies) = satisfies {
        receipt["satisfies"] = json!(satisfies);
    }
    receipt
}

fn safe(path: &str) -> Option<&str> {
    safe_workspace_path(path)
}

pub(super) fn failure(
    tool: &str,
    error: &str,
    paths: &[String],
    applied: &[Value],
    conflicting: &[Value],
    not_attempted: &[Value],
) -> Vec<Value> {
    let paths = paths
        .iter()
        .filter_map(|path| safe(path).map(str::to_owned))
        .take(20)
        .collect::<Vec<_>>();
    let record_paths = |records: &[Value]| -> Vec<String> {
        records
            .iter()
            .filter_map(|record| {
                record
                    .get("path")
                    .and_then(Value::as_str)
                    .and_then(safe)
                    .map(str::to_owned)
            })
            .take(20)
            .collect()
    };
    let applied = record_paths(applied);
    let conflicting = record_paths(conflicting);
    let not_attempted = record_paths(not_attempted);
    let mut seen = std::collections::HashSet::new();
    let references = applied
        .iter()
        .chain(&conflicting)
        .chain(&not_attempted)
        .chain(&paths)
        .filter(|path| seen.insert((*path).clone()))
        .map(|path| json!({"path":path}))
        .collect();
    vec![capability(Receipt {
        tool,
        capability: "limitation_recorded",
        kind: "mutation_result",
        maturity: "rejected",
        verified: false,
        confidence: 0.9,
        summary: "File mutation was rejected or stopped with bounded conflict state.",
        scope: json!({"tool":tool,"error":error,"paths":paths,"applied":applied,"conflicting":conflicting,"not_attempted":not_attempted}),
        references,
        satisfies: None,
        limitations: vec!["No file content or private absolute path was exposed in the receipt."],
    })]
}

#[derive(Clone, Copy)]
pub(super) enum MutationOperation {
    Created,
    Overwritten,
    Edited,
    Batch { edited: bool },
}

pub(super) fn success(
    tool: &str,
    path: Option<&str>,
    paths: &[String],
    applied: &[Value],
    operation: MutationOperation,
    bytes: usize,
) -> Vec<Value> {
    let path = path.and_then(safe);
    let paths = paths
        .iter()
        .filter_map(|path| safe(path).map(str::to_owned))
        .take(20)
        .collect::<Vec<_>>();
    let applied = applied
        .iter()
        .filter_map(|record| {
            record
                .get("path")
                .and_then(Value::as_str)
                .and_then(safe)
                .map(str::to_owned)
        })
        .take(20)
        .collect::<Vec<_>>();
    let references = if paths.is_empty() {
        path.map_or_else(Vec::new, |path| vec![json!({"path":path})])
    } else {
        paths.iter().map(|path| json!({"path":path})).collect()
    };
    let (label, created, overwritten) = match operation {
        MutationOperation::Created => ("created", true, false),
        MutationOperation::Overwritten => ("overwritten", false, true),
        MutationOperation::Edited => ("edited", false, true),
        MutationOperation::Batch { edited: true } => ("edited", false, false),
        MutationOperation::Batch { edited: false } => ("written", false, false),
    };
    let mut scope = json!({"operation":label,"created":created,"overwritten":overwritten,
        "paths":paths,"applied":applied,"bytes":bytes});
    if !paths.is_empty() {
        scope["files_written"] = json!(paths.len());
    }
    let mut receipts = vec![capability(Receipt {
        tool,
        capability: "workspace_mutated",
        kind: "mutation_result",
        maturity: "verified",
        verified: true,
        confidence: 1.0,
        summary: "File mutation completed with redacted path metadata.",
        scope,
        references: references.clone(),
        satisfies: None,
        limitations: Vec::new(),
    })];
    if path.is_some() || !paths.is_empty() {
        receipts.push(capability(Receipt {
            tool,
            capability: "durable_artifact",
            kind: "artifact",
            maturity: "verified",
            verified: true,
            confidence: 0.95,
            summary: "File mutation produced durable workspace file evidence.",
            scope: json!({"operation":label,"paths":paths,"applied":applied,"bytes":bytes}),
            references,
            satisfies: Some(vec!["durable_artifact"]),
            limitations: Vec::new(),
        }));
    }
    receipts
}

pub(super) fn execution(tool: &str, summary: &str, references: &Value) -> Vec<Value> {
    vec![json!({
        "schema":"butler.evidence-receipt.v1",
        "id":format!("receipt-{tool}-{}", Uuid::new_v4()),
        "producer":{"kind":"tool","name":tool}, "receiptType":"execution",
        "verified":true,"covers":["execution_result","workspace_file_written"],
        "summary":summary,"references":[references],"satisfies":["durable_artifact"]
    })]
}
