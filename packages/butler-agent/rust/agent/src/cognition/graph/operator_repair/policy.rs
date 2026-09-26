//! Durable set-extractor model policy updates.

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::error;
use crate::cognition::CognitionResult;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct ProjectionModelPolicyInput {
    pub(crate) primary_model: String,
    pub(crate) primary_effort: String,
    pub(crate) fallback_model: String,
    pub(crate) fallback_effort: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(in crate::cognition) enum ProjectionModelSlot {
    Primary,
    Fallback,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub(in crate::cognition) struct ProjectionModelPolicy {
    pub(in crate::cognition) primary_model: String,
    pub(in crate::cognition) primary_effort: String,
    pub(in crate::cognition) fallback_model: String,
    pub(in crate::cognition) fallback_effort: String,
    pub(in crate::cognition) active_slot: ProjectionModelSlot,
    pub(in crate::cognition) updated_at: String,
    pub(in crate::cognition) last_transition_json: Option<String>,
}

pub(super) fn configure_projection_model_policy(
    connection: &mut Connection,
    policy: &ProjectionModelPolicyInput,
    now: &str,
) -> CognitionResult<ProjectionModelPolicy> {
    let tx = connection.transaction().map_err(super::super::db_error)?;
    let running: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM memory_projection_windows WHERE state='running')",
            [],
            |row| row.get(0),
        )
        .map_err(super::super::db_error)?;
    if running {
        return Err(error("memory_projection_model_change_busy"));
    }
    tx.execute(
        "INSERT INTO memory_projection_model_policy \
         (id,primary_model,primary_effort,fallback_model,fallback_effort,active_slot,updated_at,last_transition_json) \
         VALUES(1,?1,?2,?3,?4,'primary',?5,NULL) \
         ON CONFLICT(id) DO UPDATE SET primary_model=excluded.primary_model, \
           primary_effort=excluded.primary_effort,fallback_model=excluded.fallback_model, \
           fallback_effort=excluded.fallback_effort,active_slot='primary', \
           updated_at=excluded.updated_at,last_transition_json=NULL",
        params![
            policy.primary_model,
            policy.primary_effort,
            policy.fallback_model,
            policy.fallback_effort,
            now,
        ],
    )
    .map_err(super::super::db_error)?;
    let configured =
        read_projection_model_policy(&tx)?.ok_or_else(|| error("memory_graph_failed"))?;
    tx.commit().map_err(super::super::db_error)?;
    Ok(configured)
}

fn read_projection_model_policy(
    connection: &Connection,
) -> CognitionResult<Option<ProjectionModelPolicy>> {
    connection
        .query_row(
            "SELECT primary_model,primary_effort,fallback_model,fallback_effort, \
             active_slot,updated_at,last_transition_json \
             FROM memory_projection_model_policy WHERE id=1",
            [],
            |row| {
                let slot: String = row.get(4)?;
                Ok((ProjectionModelPolicy {
                    primary_model: row.get(0)?,
                    primary_effort: row.get(1)?,
                    fallback_model: row.get(2)?,
                    fallback_effort: row.get(3)?,
                    active_slot: parse_slot(&slot)?,
                    updated_at: row.get(5)?,
                    last_transition_json: row.get(6)?,
                },))
            },
        )
        .optional()
        .map(|value| value.map(|(policy,)| policy))
        .map_err(super::super::db_error)
}

fn parse_slot(value: &str) -> rusqlite::Result<ProjectionModelSlot> {
    match value {
        "primary" => Ok(ProjectionModelSlot::Primary),
        "fallback" => Ok(ProjectionModelSlot::Fallback),
        _ => Err(rusqlite::Error::FromSqlConversionFailure(
            4,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::other("invalid projection model slot")),
        )),
    }
}
