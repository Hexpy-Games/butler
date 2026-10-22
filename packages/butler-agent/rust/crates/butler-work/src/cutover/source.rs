use super::{shape::Action, sql};
use crate::store::{Error, Result};
use rusqlite::{Connection, OptionalExtension, Row};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub(super) struct Source {
    // Passthrough: immutable legacy metadata, retained without interpreting its
    // authority/provenance fields or rewriting transcripts.
    pub work: Value,
    pub actions: Vec<Action>,
    pub progress: Value,
    pub hash: String,
    pub delegated: bool,
    pub delegation_id: Option<String>,
}

pub(super) fn row_json(row: &Row<'_>) -> rusqlite::Result<Value> {
    let mut object = serde_json::Map::new();
    for (i, name) in row.as_ref().column_names().iter().enumerate() {
        let value = match row.get_ref(i)? {
            rusqlite::types::ValueRef::Null => Value::Null,
            rusqlite::types::ValueRef::Integer(n) => json!(n),
            rusqlite::types::ValueRef::Real(n) => json!(n),
            rusqlite::types::ValueRef::Text(s) => json!(String::from_utf8_lossy(s)),
            rusqlite::types::ValueRef::Blob(_) => return Err(rusqlite::Error::InvalidQuery),
        };
        object.insert((*name).into(), value);
    }
    Ok(Value::Object(object))
}

pub(super) fn load(db: &Connection, id: &str) -> Result<Source> {
    let work = db.query_row(sql::WORK, [id], row_json)?;
    let plan = db.query_row(sql::PLAN, [id], row_json).optional()?;
    let checkpoint = db.query_row(sql::CHECKPOINT, [id], row_json).optional()?;
    let delegation = db.query_row(sql::DELEGATION, [id], row_json).optional()?;
    if let Some(delegation) = &delegation {
        validate_delegation(&work, delegation)?;
    }
    let actions = plan
        .as_ref()
        .and_then(|p| p["actions_json"].as_str())
        .map(serde_json::from_str)
        .transpose()?
        .unwrap_or_default();
    let progress = checkpoint
        .as_ref()
        .and_then(|p| p["action_states_json"].as_str())
        .map(serde_json::from_str)
        .transpose()?
        .unwrap_or_else(|| json!([]));
    let mut digest = Sha256::new();
    digest.update(serde_json::to_vec(&work)?);
    digest.update(serde_json::to_vec(&delegation)?);
    // One-time import reads revision history through UNIQUE(work_id,revision)
    // indexes. Stream hashes one row at a time; large records are not batched
    // together or copied into audit. Original tables remain the provenance.
    for statement in sql::HISTORY {
        digest.update(statement.as_bytes());
        let mut stmt = db.prepare(statement)?;
        let mut rows = stmt.query([id])?;
        while let Some(row) = rows.next()? {
            let bytes = serde_json::to_vec(&row_json(row)?)?;
            digest.update((bytes.len() as u64).to_le_bytes());
            digest.update(bytes);
        }
    }
    Ok(Source {
        work,
        actions,
        progress,
        hash: format!("{:x}", digest.finalize()),
        delegated: delegation.is_some(),
        delegation_id: delegation
            .as_ref()
            .map(|v| text(v, "delegation_id").map(str::to_owned))
            .transpose()?,
    })
}

pub(super) fn text<'a>(value: &'a Value, field: &str) -> Result<&'a str> {
    value[field]
        .as_str()
        .ok_or(Error::Invalid("missing legacy field"))
}

#[derive(serde::Deserialize)]
struct DelegationProof {
    delegation_id: String,
    relation_id: String,
    task_id: String,
    parent_session_id: String,
}
fn validate_delegation(work: &Value, delegation: &Value) -> Result<()> {
    let proof: DelegationProof = serde_json::from_str(text(delegation, "packet_json")?)?;
    if proof.delegation_id != text(delegation, "delegation_id")?
        || proof.relation_id != text(delegation, "relation_id")?
        || proof.task_id != text(delegation, "task_id")?
        || proof.parent_session_id != text(delegation, "parent_session_id")?
        || text(work, "session_id")? != text(delegation, "child_session_id")?
    {
        return Err(Error::Invalid("unresolvable_delegation"));
    }
    Ok(())
}
