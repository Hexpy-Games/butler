use std::fs;
use std::path::Path;

use crate::locale::LocaleCollation;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::super::{invalid, required_string};
use crate::json;
use crate::project_ledger::ProjectLedgerReadError;
use crate::project_ledger::dashboard::{DashboardLedgerRecord, ProjectLedgerBinding, exact};

pub(super) fn validate(
    root: &Path,
    binding: &ProjectLedgerBinding,
    record_id: &str,
    kind: &str,
    document: &Value,
    collation: &LocaleCollation,
) -> Result<(), ProjectLedgerReadError> {
    let identity = document.get("operationIdentity").ok_or_else(invalid)?;
    let operation_kind = required_string(identity, "kind")?;
    let operation_id = required_string(identity, "id")?;
    let request_sha = required_string(identity, "requestSha256")?;
    if !matches!(
        operation_kind,
        "mutation_call"
            | "binding_revision"
            | "closeout_diagnostic"
            | "abandonment"
            | "legacy_import"
    ) || !digest_shape(request_sha)
        || operation_kind == "mutation_call"
            && identity.get("mutationCallId").and_then(Value::as_str) != Some(operation_id)
    {
        return Err(invalid());
    }
    let identity_bytes = format!(
        "{{\"ledgerProjectId\":{},\"operationKind\":{},\"operationId\":{}}}",
        string(&binding.ledger_project_id)?,
        string(operation_kind)?,
        string(operation_id)?
    );
    let occurrence_id = format!("{:x}", Sha256::digest(identity_bytes.as_bytes()));
    let data_root = root
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or_else(invalid)?;
    let storage = data_root.join("runtime/btcc-project-ledger-effects-v2");
    let occurrence_path = storage
        .join("occurrences")
        .join(format!("{occurrence_id}.json"));
    let occurrence: Value =
        serde_json::from_slice(&fs::read(occurrence_path).map_err(|_| invalid())?)
            .map_err(|_| invalid())?;
    if occurrence.get("schema").and_then(Value::as_str)
        != Some("butler.btcc-project-ledger-effect-occurrence.v2")
        || occurrence.get("occurrenceId").and_then(Value::as_str) != Some(&occurrence_id)
        || occurrence.get("status").and_then(Value::as_str) != Some("pending")
        || occurrence.get("ledgerProjectId").and_then(Value::as_str)
            != Some(&binding.ledger_project_id)
        || occurrence.get("ledgerRoot").and_then(Value::as_str) != root.to_str()
        || occurrence
            .pointer("/operationIdentity/kind")
            .and_then(Value::as_str)
            != Some(operation_kind)
        || occurrence
            .pointer("/operationIdentity/id")
            .and_then(Value::as_str)
            != Some(operation_id)
    {
        return Err(invalid());
    }
    let attempts = occurrence
        .get("attempts")
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty())
        .ok_or_else(invalid)?;
    for (index, candidate) in attempts.iter().enumerate() {
        let publication = required_string(candidate, "publicationId")?;
        if candidate.get("number").and_then(Value::as_u64) != Some(index as u64 + 1)
            || candidate.get("status").and_then(Value::as_str) != Some("admitted")
            || candidate.get("requestSha256").and_then(Value::as_str) != Some(request_sha)
            || candidate
                .get("expectedBase")
                .is_none_or(|head| validate_head(head, root).is_err())
            || candidate
                .get("targetPreconditions")
                .and_then(Value::as_array)
                .is_none_or(Vec::is_empty)
            || expected_publication(&occurrence_id, candidate)? != publication
        {
            return Err(invalid());
        }
    }
    let attempt = attempts.last().ok_or_else(invalid)?;
    let publication_id = required_string(attempt, "publicationId")?;
    if !digest_shape(publication_id)
        || attempt.get("status").and_then(Value::as_str) != Some("admitted")
        || attempt.get("requestSha256").and_then(Value::as_str) != Some(request_sha)
        || attempt.get("number").and_then(Value::as_u64) != Some(attempts.len() as u64)
    {
        return Err(invalid());
    }
    let receipt: Value = serde_json::from_slice(
        &fs::read(
            storage
                .join("receipts")
                .join(format!("{publication_id}.json")),
        )
        .map_err(|_| invalid())?,
    )
    .map_err(|_| invalid())?;
    if receipt.get("schema").and_then(Value::as_str)
        != Some("butler.btcc-project-ledger-publication-receipt.v1")
        || receipt.get("occurrenceId").and_then(Value::as_str) != Some(&occurrence_id)
        || receipt.get("publicationId").and_then(Value::as_str) != Some(publication_id)
        || receipt.get("requestSha256").and_then(Value::as_str) != Some(request_sha)
        || receipt.get("attemptNumber") != attempt.get("number")
        || receipt.get("status").and_then(Value::as_str) != Some("observed")
        || receipt.get("baseHead") != attempt.get("expectedBase")
        || receipt
            .get("candidateHead")
            .is_none_or(|head| validate_head(head, root).is_err())
    {
        return Err(invalid());
    }
    let targets = attempt
        .get("targetPreconditions")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    let parent = if kind == "work" {
        Value::Null
    } else {
        Value::String(required_string(document, "workId")?.into())
    };
    if targets
        .iter()
        .filter(|target| {
            target.get("id").and_then(Value::as_str) == Some(record_id)
                && target.get("kind").and_then(Value::as_str) == Some(kind)
                && target.get("parentId") == Some(&parent)
        })
        .count()
        != 1
    {
        return Err(invalid());
    }
    let proof_id = publication_proof(root, binding, record_id, kind, document, collation)?;
    if targets
        .iter()
        .filter(|target| {
            target.get("id").and_then(Value::as_str) == Some(&proof_id)
                && target.get("kind").and_then(Value::as_str) == Some("reference")
                && target.get("parentId") == Some(&Value::Null)
                && target.get("state").and_then(Value::as_str) == Some("absent")
        })
        .count()
        != 1
    {
        return Err(invalid());
    }
    Ok(())
}

fn expected_publication(
    occurrence_id: &str,
    attempt: &Value,
) -> Result<String, ProjectLedgerReadError> {
    let payload = json!({
        "schema":"butler.btcc-project-ledger-effect-publication.v2",
        "occurrenceId":occurrence_id,
        "attemptNumber":attempt.get("number"),
        "requestSha256":attempt.get("requestSha256"),
        "expectedBase":attempt.get("expectedBase"),
        "targetPreconditions":attempt.get("targetPreconditions"),
    });
    let body = json::stringify(&payload).map_err(|_| invalid())?;
    Ok(format!("{:x}", Sha256::digest(body.as_bytes())))
}

fn validate_head(head: &Value, root: &Path) -> Result<(), ProjectLedgerReadError> {
    let value = head.as_object().ok_or_else(invalid)?;
    let keys = [
        "schema",
        "projectRoot",
        "sourceSha256",
        "sourceFileCount",
        "storageSha256",
        "storageEntryCount",
    ];
    if keys.iter().any(|key| !value.contains_key(*key))
        || value
            .keys()
            .any(|key| !keys.contains(&key.as_str()) && key != "recordPaths")
        || head.get("schema").and_then(Value::as_str) != Some("butler.btcc-project-ledger-head.v1")
        || head.get("projectRoot").and_then(Value::as_str) != root.to_str()
        || !digest_shape(required_string(head, "sourceSha256")?)
        || !digest_shape(required_string(head, "storageSha256")?)
        || head
            .get("sourceFileCount")
            .and_then(Value::as_u64)
            .is_none()
        || head
            .get("storageEntryCount")
            .and_then(Value::as_u64)
            .is_none()
    {
        return Err(invalid());
    }
    if let Some(paths) = head.get("recordPaths") {
        let paths = paths.as_array().ok_or_else(invalid)?;
        if paths.iter().any(|path| path.as_str().is_none()) {
            return Err(invalid());
        }
    }
    Ok(())
}

fn publication_proof(
    root: &Path,
    binding: &ProjectLedgerBinding,
    record_id: &str,
    kind: &str,
    document: &Value,
    collation: &LocaleCollation,
) -> Result<String, ProjectLedgerReadError> {
    let parent_id = if kind == "work" {
        None
    } else {
        Some(required_string(document, "workId")?.to_owned())
    };
    let directory = if kind == "work" {
        "work"
    } else if kind == "plan" {
        "plans"
    } else {
        "references"
    };
    let path = if kind == "work" {
        format!(
            "project-ledger/projects/{}/work/{record_id}/work.md",
            binding.ledger_project_id
        )
    } else {
        format!(
            "project-ledger/projects/{}/{directory}/{}.md",
            binding.ledger_project_id,
            record_id.to_lowercase()
        )
    };
    let target = DashboardLedgerRecord {
        id: record_id.into(),
        kind: kind.into(),
        title: String::new(),
        status: String::new(),
        path,
        parent_id: parent_id.clone(),
        spec: Some(super::super::PROJECT_WORK_SPEC.into()),
        updated_at: String::new(),
        priority: 100.0,
        unavailable: false,
    };
    let exact = exact::read_record(root, &binding.ledger_project_id, &target)?;
    let metadata = &exact.metadata;
    let title = required_string(metadata, "title")?;
    let status = required_string(metadata, "status")?;
    if metadata.get("spec").and_then(Value::as_str) != Some(super::super::PROJECT_WORK_SPEC)
        || metadata.get("schema").and_then(Value::as_str)
            != Some(format!("project-ledger.{kind}.v1").as_str())
    {
        return Err(invalid());
    }
    let record = json!({"id":record_id,"kind":kind,"parentId":parent_id,"title":title,
        "status":status,"spec":super::super::PROJECT_WORK_SPEC,
        "schema":format!("project-ledger.{kind}.v1"),"body":exact.body});
    let content = json!({"schema":"butler.btcc-project-work-publication-proof.v1","record":record});
    let digest = format!(
        "{:x}",
        Sha256::digest(
            crate::project_ledger::work_json::canonical(&content, collation)?.as_bytes()
        )
    );
    Ok(format!("btcc-project-work-proof-{digest}"))
}

fn digest_shape(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn string(value: &str) -> Result<String, ProjectLedgerReadError> {
    json::stringify(&Value::String(value.into())).map_err(|_| invalid())
}
