use std::path::Path;

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{ManagedPlanView, invalid, required_string};
use crate::locale::LocaleCollation;
use crate::project_ledger::ProjectLedgerReadError;
use crate::project_ledger::dashboard::{DashboardLedgerRecord, ProjectLedgerBinding, exact};
use crate::project_ledger::work_json::canonical;

pub(super) fn parse_canonical(
    body: &str,
    collation: &LocaleCollation,
) -> Result<Value, ProjectLedgerReadError> {
    if body.encode_utf16().count() > 1_048_576 {
        return Err(invalid());
    }
    let value: Value = serde_json::from_str(body).map_err(|_| invalid())?;
    if !value.is_object() || canonical(&value, collation)? != body {
        return Err(invalid());
    }
    Ok(value)
}

pub(super) fn read_child(
    root: &Path,
    binding: &ProjectLedgerBinding,
    work_id: &str,
    id: &str,
    schema: &str,
    collation: &LocaleCollation,
) -> Result<Value, ProjectLedgerReadError> {
    if id.is_empty() || id == "." || id == ".." || id.contains(['/', '\\']) {
        return Err(invalid());
    }
    let kind = if schema.ends_with("-plan.v1") {
        "plan"
    } else {
        "reference"
    };
    let directory = if kind == "plan" {
        "plans"
    } else {
        "references"
    };
    let target = DashboardLedgerRecord {
        id: id.into(),
        kind: kind.into(),
        title: String::new(),
        status: "active".into(),
        path: format!(
            "project-ledger/projects/{}/{directory}/{}.md",
            binding.ledger_project_id,
            id.to_lowercase()
        ),
        parent_id: Some(work_id.into()),
        spec: Some(super::PROJECT_WORK_SPEC.into()),
        updated_at: String::new(),
        priority: 100.0,
        unavailable: false,
    };
    let exact = exact::read_record(root, &binding.ledger_project_id, &target)?;
    if exact.metadata.get("schema").and_then(Value::as_str)
        != Some(format!("project-ledger.{kind}.v1").as_str())
        || exact.metadata.get("spec").and_then(Value::as_str) != Some(super::PROJECT_WORK_SPEC)
        || exact.metadata.get("status").and_then(Value::as_str) != Some("active")
        || exact
            .metadata
            .get("title")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
    {
        return Err(invalid());
    }
    let value = decode_body(&exact.body, work_id, id, schema, collation)?;
    exact::revalidate(root, &binding.ledger_project_id, &target, &exact.revision)?;
    Ok(value)
}

pub(super) fn decode_body(
    body: &str,
    work_id: &str,
    id: &str,
    schema: &str,
    collation: &LocaleCollation,
) -> Result<Value, ProjectLedgerReadError> {
    let value = parse_canonical(body, collation)?;
    let object = value.as_object().ok_or_else(invalid)?;
    let property = if schema.ends_with("-plan.v1") {
        "plan"
    } else if schema.ends_with("-checkpoint.v1") {
        "checkpoint"
    } else if schema.ends_with("-review.v1") {
        "review"
    } else if schema.ends_with("-disposition.v1") {
        "disposition"
    } else if schema.ends_with("-result-reference.v1") {
        "result"
    } else if schema.ends_with("-binding.v1") {
        "binding"
    } else {
        return Err(invalid());
    };
    let mut required = vec![
        "schema",
        "workId",
        "operationIdentity",
        "recordSha256",
        property,
    ];
    if schema.ends_with("-checkpoint.v1") {
        required.extend(["checkpointIdentity", "resultWindow"]);
    }
    if schema.ends_with("-review.v1") {
        required.push("boundResultSequence");
    }
    if schema.ends_with("-disposition.v1") {
        required.push("materialSnapshot");
    }
    if schema.ends_with("-result-reference.v1") {
        required.extend(["sessionId", "scope"]);
    }
    if object.len() != required.len()
        || required.iter().any(|key| !object.contains_key(*key))
        || required_string(&value, "schema")? != schema
        || required_string(&value, "workId")? != work_id
    {
        return Err(invalid());
    }
    let child = value.get(property).ok_or_else(invalid)?;
    super::validate::child(&value, property)?;
    let id_key = match property {
        "plan" => "planRevisionId",
        "checkpoint" => "checkpointRevisionId",
        "review" => "reviewRevisionId",
        "disposition" => "dispositionRevisionId",
        "result" => "resultRef",
        _ => "bindingRevisionId",
    };
    if child.get(id_key).and_then(Value::as_str) != Some(id) {
        return Err(invalid());
    }
    let recorded_digest = required_string(&value, "recordSha256")?;
    if recorded_digest.len() != 64
        || !recorded_digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(invalid());
    }
    let mut semantic = object.clone();
    semantic.remove("recordSha256");
    let digest = format!(
        "{:x}",
        Sha256::digest(canonical(&Value::Object(semantic), collation)?.as_bytes())
    );
    if digest != recorded_digest {
        return Err(invalid());
    }
    Ok(value)
}

pub(super) fn read_plan(
    root: &Path,
    binding: &ProjectLedgerBinding,
    work_id: &str,
    id: &str,
    collation: &LocaleCollation,
) -> Result<ManagedPlanView, ProjectLedgerReadError> {
    let value = read_child(
        root,
        binding,
        work_id,
        id,
        "butler.btcc-project-work-plan.v1",
        collation,
    )?;
    let plan = value.get("plan").ok_or_else(invalid)?;
    let actions = plan
        .get("actions")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    if actions.len() > 512 {
        return Err(invalid());
    }
    let actions = actions
        .iter()
        .map(|item| required_string(item, "description").map(str::to_owned))
        .collect::<Result<Vec<_>, _>>()?;
    let checks = strings(plan.get("checks").ok_or_else(invalid)?)?;
    Ok(ManagedPlanView {
        id: id.into(),
        objective: required_string(plan, "objective")?.into(),
        created_at: required_string(plan, "createdAt")?.into(),
        actions,
        checks,
    })
}

pub(super) fn strings(value: &Value) -> Result<Vec<String>, ProjectLedgerReadError> {
    let items = value
        .as_array()
        .filter(|items| items.len() <= 512)
        .ok_or_else(invalid)?;
    items
        .iter()
        .map(|item| {
            item.as_str()
                .filter(|value| {
                    !crate::public_text::trim_js_whitespace(value).is_empty()
                        && value.encode_utf16().count() <= 4096
                })
                .map(str::to_owned)
                .ok_or_else(invalid)
        })
        .collect()
}
