use std::path::Path;

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{ManagedPlanView, invalid, required_string};
use crate::project_ledger::ProjectLedgerReadError;
use crate::project_ledger::dashboard::{DashboardLedgerRecord, ProjectLedgerBinding, exact};
use crate::project_ledger::work_json::canonical;
use butler_core::locale::LocaleCollation;

pub(super) fn parse_canonical(
    body: &str,
    collation: &LocaleCollation,
) -> Result<Value, ProjectLedgerReadError> {
    if body.encode_utf16().count() > 1_048_576 {
        return Err(invalid());
    }
    let value: Value =
        serde_json::from_str(body).map_err(|source| invalid().with_source(source))?;
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

/// Which payload a managed Work child carries, from its schema suffix.
#[derive(Clone, Copy)]
pub(super) enum Part {
    Plan,
    Checkpoint,
    Review,
    Disposition,
    Result,
    Binding,
}

impl Part {
    fn from_schema(schema: &str) -> Option<Self> {
        [
            ("-plan.v1", Self::Plan),
            ("-checkpoint.v1", Self::Checkpoint),
            ("-review.v1", Self::Review),
            ("-disposition.v1", Self::Disposition),
            ("-result-reference.v1", Self::Result),
            ("-binding.v1", Self::Binding),
        ]
        .into_iter()
        .find_map(|(suffix, part)| schema.ends_with(suffix).then_some(part))
    }

    /// The key holding the payload.
    pub(super) fn property(self) -> &'static str {
        match self {
            Self::Plan => "plan",
            Self::Checkpoint => "checkpoint",
            Self::Review => "review",
            Self::Disposition => "disposition",
            Self::Result => "result",
            Self::Binding => "binding",
        }
    }

    /// Top-level keys this child has besides the common ones.
    fn extra_keys(self) -> &'static [&'static str] {
        match self {
            Self::Checkpoint => &["checkpointIdentity", "resultWindow"],
            Self::Review => &["boundResultSequence"],
            Self::Disposition => &["materialSnapshot"],
            Self::Result => &["sessionId", "scope"],
            Self::Plan | Self::Binding => &[],
        }
    }

    /// The payload key naming the child's record id.
    fn id_key(self) -> &'static str {
        match self {
            Self::Plan => "planRevisionId",
            Self::Checkpoint => "checkpointRevisionId",
            Self::Review => "reviewRevisionId",
            Self::Disposition => "dispositionRevisionId",
            Self::Result => "resultRef",
            Self::Binding => "bindingRevisionId",
        }
    }
}

/// A child record body: canonical JSON with exactly its schema's keys, for
/// this Work and id, whose recorded digest matches its semantic content.
pub(super) fn decode_body(
    body: &str,
    work_id: &str,
    id: &str,
    schema: &str,
    collation: &LocaleCollation,
) -> Result<Value, ProjectLedgerReadError> {
    let value = parse_canonical(body, collation)?;
    let object = value.as_object().ok_or_else(invalid)?;
    let part = Part::from_schema(schema).ok_or_else(invalid)?;
    let common = [
        "schema",
        "workId",
        "operationIdentity",
        "recordSha256",
        part.property(),
    ];
    let required = || common.iter().chain(part.extra_keys());
    if object.len() != required().count()
        || required().any(|key| !object.contains_key(*key))
        || required_string(&value, "schema")? != schema
        || required_string(&value, "workId")? != work_id
    {
        return Err(invalid());
    }
    let child = value.get(part.property()).ok_or_else(invalid)?;
    super::validate::child(&value, part)?;
    if child.get(part.id_key()).and_then(Value::as_str) != Some(id) {
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
                    !butler_core::public_text::trim_js_whitespace(value).is_empty()
                        && value.encode_utf16().count() <= 4096
                })
                .map(str::to_owned)
                .ok_or_else(invalid)
        })
        .collect()
}
