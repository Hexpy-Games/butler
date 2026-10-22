//! Relocate the static publication's absolute root and its derived receipt ID.
use butler_e2e::e2e::{HarnessError, harness_error};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::Path;

pub(super) fn install(data: &Path) -> Result<(), HarnessError> {
    let root = data.join("project-ledger/projects/legacy-ledger");
    let mut source: Value = serde_json::from_str(include_str!(
        "../../../fixtures/work-model-cutover/ledger-provenance.json"
    ))?;
    relocate(&mut source, &root.to_string_lossy());
    let occurrence_id = source["occurrence"]["occurrenceId"]
        .as_str()
        .unwrap()
        .to_owned();
    let attempt = &source["occurrence"]["attempts"][0];
    let payload = json!({
        "schema":"butler.btcc-project-ledger-effect-publication.v2",
        "occurrenceId":occurrence_id,
        "attemptNumber":attempt["number"],
        "requestSha256":attempt["requestSha256"],
        "expectedBase":attempt["expectedBase"],
        "targetPreconditions":attempt["targetPreconditions"],
    });
    let bytes = butler_core::json::stringify(&payload).map_err(|e| harness_error(e.to_string()))?;
    let publication = format!("{:x}", Sha256::digest(bytes));
    source["occurrence"]["attempts"][0]["publicationId"] = json!(publication);
    source["receipt"]["publicationId"] = json!(publication);
    let evidence = data.join("runtime/btcc-project-ledger-effects-v2");
    for (folder, id, value) in [
        ("occurrences", occurrence_id, &source["occurrence"]),
        ("receipts", publication, &source["receipt"]),
    ] {
        std::fs::create_dir_all(evidence.join(folder))?;
        std::fs::write(
            evidence.join(folder).join(format!("{id}.json")),
            serde_json::to_vec(value)?,
        )?;
    }
    std::fs::create_dir_all(root.join("references"))?;
    let proof = source["proof_id"].as_str().unwrap();
    let body = serde_json::to_string(&source["proof"])?;
    std::fs::write(
        root.join("references").join(format!("{proof}.md")),
        format!(
            "---\nschema: project-ledger.reference.v1\nkind: reference\nid: {proof}\ntitle: Work publication proof\nstatus: active\n---\n\n{body}"
        ),
    )?;
    Ok(())
}
fn relocate(value: &mut Value, root: &str) {
    match value {
        Value::String(text) if text == "fixture-ledger-root" => *text = root.into(),
        Value::Array(items) => {
            for value in items {
                relocate(value, root);
            }
        }
        Value::Object(fields) => {
            for value in fields.values_mut() {
                relocate(value, root);
            }
        }
        _ => {}
    }
}
