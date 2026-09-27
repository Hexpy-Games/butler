use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{Value, json};
use uuid::Uuid;

use super::artifacts::Artifact;

fn now() -> String {
    DateTime::<Utc>::from(std::time::SystemTime::now()).to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn id(prefix: &str) -> String {
    format!("{}-{}", prefix, &Uuid::new_v4().to_string()[..12])
}

pub(super) fn receipts(success: bool, artifacts: &[Artifact]) -> Vec<Value> {
    let mut result = vec![json!({
        "schema":"butler.evidence-receipt.v1", "id":id("receipt"),
        "producer":{"kind":"tool","name":"run_command"},
        "receiptType":"execution", "verified":success, "covers":["execution_result"],
        "summary":if success { "A local command executed successfully." } else { "A local command was executed but did not complete successfully." },
        "references":[], "satisfies":if success { vec!["command_executed"] } else { Vec::new() },
    })];
    if !artifacts.is_empty() {
        let table = artifacts
            .iter()
            .any(|a| matches!(a.artifact_kind, "csv_file" | "table_file"));
        let chart = artifacts.iter().any(|a| a.artifact_kind == "chart_file");
        let mut satisfies = vec!["durable_artifact"];
        if table {
            satisfies.push("data_table_created");
        }
        if chart {
            satisfies.push("chart_rendered");
        }
        result.push(json!({
            "schema":"butler.evidence-receipt.v1", "id":id("receipt"),
            "producer":{"kind":"tool","name":"run_command"},
            "receiptType":"deliverable", "verified":true, "covers":["durable_deliverable"],
            "summary":"The command produced verified durable output file evidence.",
            "references":[], "satisfies":satisfies,
            "artifacts":artifacts.iter().map(|a| json!({
                "label":a.path,"path":a.path,"mediaType":media_type(a),"role":role(a)
            })).collect::<Vec<_>>(),
            "metrics":{"artifact_count":artifacts.len()}
        }));
    }
    result
}

pub(super) fn capability_receipts(
    exit: Option<i32>,
    timed_out: bool,
    suppressed: bool,
    budgeted: bool,
    artifacts: &[Artifact],
) -> Vec<Value> {
    let status = if timed_out {
        "timed_out"
    } else if exit == Some(0) {
        "succeeded"
    } else {
        "failed"
    };
    let verified = status == "succeeded";
    let label = exit.map_or_else(|| "none".into(), |exit| exit.to_string());
    let mut first = base(
        "command_executed",
        "execution_result",
        if verified {
            "verified"
        } else if timed_out {
            "candidate"
        } else {
            "rejected"
        },
        verified,
        if verified {
            1.0
        } else if timed_out {
            0.45
        } else {
            0.65
        },
        &format!("Command execution {status} with exit code {label}."),
    );
    first["scope"] = json!({"status":status,"exit_code":exit,"timed_out":timed_out,
        "output_suppressed":suppressed,"output_budgeted":budgeted});
    if verified {
        first["satisfies"] = json!(["command_executed"]);
    } else {
        first["limitations"] = json!(["Command execution did not complete successfully."]);
    }
    let mut result = vec![first];
    for artifact in artifacts {
        if !safe(&artifact.path) {
            continue;
        }
        let reference = json!([{"label":artifact.path,"path":artifact.path}]);
        let scope = json!({"artifact_kind":artifact.artifact_kind,"size_bytes":artifact.size_bytes,"modified_at":artifact.modified_at});
        let mut receipt = base(
            "durable_artifact",
            "artifact",
            "verified",
            true,
            0.9,
            "Command produced a verified durable artifact reference.",
        );
        receipt["scope"] = scope.clone();
        receipt["references"] = reference.clone();
        receipt["satisfies"] = json!(["durable_artifact"]);
        result.push(receipt);
        let extra = match artifact.artifact_kind {
            "csv_file" | "table_file" => Some((
                "data_table_created",
                "data_table",
                "Command produced a verified structured table artifact.",
            )),
            "chart_file" => Some((
                "chart_rendered",
                "chart",
                "Command produced a verified chart artifact.",
            )),
            _ => None,
        };
        if let Some((capability, kind, summary)) = extra {
            let mut receipt = base(capability, kind, "verified", true, 0.9, summary);
            receipt["scope"] = scope;
            receipt["references"] = reference;
            receipt["satisfies"] = json!([capability]);
            result.push(receipt);
        }
    }
    result
}

fn base(
    capability: &str,
    kind: &str,
    maturity: &str,
    verified: bool,
    confidence: f64,
    summary: &str,
) -> Value {
    json!({"receipt_id":id("ecr"),"schema_version":"evidence-capability.v1",
        "producer":{"kind":"tool","name":"run_command"},
        "capability":capability,"evidence_kind":kind,"maturity":maturity,
        "confidence":confidence,"verified":verified,"summary":summary,
        "references":[],"limitations":[],"created_at":now()})
}
fn safe(path: &str) -> bool {
    let path = crate::public_text::trim_js_whitespace(path);
    !path.is_empty()
        && !path.starts_with('/')
        && !path.starts_with('~')
        && path.as_bytes().get(1).is_none_or(|ch| *ch != b':')
        && !path.split(['/', '\\']).any(|part| part == "..")
}
fn media_type(artifact: &Artifact) -> &'static str {
    match artifact
        .path
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "csv" => "text/csv",
        "tsv" => "text/tab-separated-values",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}
fn role(artifact: &Artifact) -> &'static str {
    match artifact.artifact_kind {
        "csv_file" | "table_file" => "table",
        "chart_file" => "chart",
        _ => "file",
    }
}
