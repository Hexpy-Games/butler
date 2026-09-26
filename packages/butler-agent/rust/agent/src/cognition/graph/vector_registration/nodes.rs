//! Node vector projection and unit registration.

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde_json::{Value, json};
use std::collections::HashSet;

use super::super::{
    CognitionError, CognitionResult, NODE_CHUNK_BYTES, OVERSIZED_GRAPHEME, db_error, digest,
    json_array, json_error, json_string, option_value, source_changed, stringify,
};
use super::{chunks, vector_unit_id};

#[derive(Clone)]
pub(super) struct NodeRow {
    pub(super) id: String,
    pub(super) node_type: String,
    pub(super) label: String,
    pub(super) origin_kind: String,
}

pub(super) fn job_chunk(
    connection: &Connection,
    job_id: &str,
) -> CognitionResult<(String, String, Option<String>, String)> {
    let (episode_id, revision) = connection
        .query_row(
            "SELECT episode_id,revision FROM memory_projection_jobs WHERE job_id=?1",
            [job_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| {
            CognitionError::new(
                "memory_projection_job_not_found",
                "memory_projection_job_not_found",
            )
        })?;
    connection
        .query_row(
            "SELECT project_id,origin_kind FROM memory_chunks WHERE memory_chunk_id=?1 AND current_revision=?2",
            params![episode_id, revision],
            |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(db_error)?
        .map(|(project_id, origin_kind)| (episode_id, revision, project_id, origin_kind))
        .ok_or_else(source_changed)
}

pub(super) fn node_rows(
    connection: &Connection,
    episode_id: &str,
    revision: &str,
) -> CognitionResult<Vec<NodeRow>> {
    let mut statement = connection
        .prepare(
            "SELECT e.id,e.type,e.label_original,s.origin_kind FROM memory_nodes e              JOIN memory_evidence m ON m.node_id=e.id              JOIN memory_chunk_sources s ON s.source_id=m.source_id              WHERE m.episode_id=?1 AND m.revision=?2              GROUP BY e.id,s.origin_kind ORDER BY e.id,s.origin_kind",
        )
        .map_err(db_error)?;
    statement
        .query_map(params![episode_id, revision], |row| {
            Ok(NodeRow {
                id: row.get(0)?,
                node_type: row.get(1)?,
                label: row.get(2)?,
                origin_kind: row.get(3)?,
            })
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)
}

pub(super) fn register(
    tx: &Transaction<'_>,
    job_id: &str,
    episode_id: &str,
    revision: &str,
    project_id: Option<&str>,
    nodes: &[NodeRow],
) -> CognitionResult<HashSet<String>> {
    let mut desired = HashSet::new();
    for node in nodes {
        let aliases = aliases(tx, &node.id, episode_id, revision, &node.origin_kind)?;
        let label = aliases.first().cloned().unwrap_or_else(|| {
            if node.node_type == "entity" || node.node_type == "project" {
                String::new()
            } else {
                node.label.clone()
            }
        });
        let claim = claim(tx, &node.id)?;
        let projection = node_projection(&node.node_type, &label, &claim, &aliases)?;
        let node_revision = digest(vec![
            json!("node-vector"),
            json!(node.id),
            option_value(project_id),
            json!(node.origin_kind),
            json!(projection),
        ])?;
        let source_ids = node_source_ids(tx, &node.id, episode_id, revision, &node.origin_kind)?;
        match chunks(&projection, NODE_CHUNK_BYTES) {
            Ok(chunks) => {
                for (ordinal, text) in chunks.into_iter().enumerate() {
                    let chunk_revision = digest(vec![
                        json!("node-vector-chunk"),
                        json!(node_revision),
                        json!(ordinal),
                        json!(text),
                    ])?;
                    let unit_id = vector_unit_id(job_id, "node", &node.id, &chunk_revision)?;
                    desired.insert(unit_id.clone());
                    tx.execute(
                        "INSERT OR IGNORE INTO memory_vector_units                          (unit_id,job_id,record_kind,owner_id,owner_revision,project_id,origin_kind,projection_text,source_ids_json)                          VALUES(?1,?2,'node',?3,?4,?5,?6,?7,?8)",
                        params![
                            unit_id,
                            job_id,
                            node.id,
                            chunk_revision,
                            project_id,
                            node.origin_kind,
                            text,
                            json_array(&source_ids)?,
                        ],
                    )
                    .map_err(db_error)?;
                    retain_receipt(
                        tx,
                        &unit_id,
                        "node",
                        &node.id,
                        &chunk_revision,
                        project_id,
                        &node.origin_kind,
                    )?;
                }
            }
            Err(()) => {
                let chunk_revision =
                    digest(vec![json!("node-vector-oversized"), json!(node_revision)])?;
                let unit_id = vector_unit_id(job_id, "node", &node.id, &chunk_revision)?;
                desired.insert(unit_id.clone());
                tx.execute(
                    "INSERT OR IGNORE INTO memory_vector_units                      (unit_id,job_id,record_kind,owner_id,owner_revision,project_id,origin_kind,projection_text,state,error_code,source_ids_json)                      VALUES(?1,?2,'node',?3,?4,?5,?6,'','failed',?7,?8)",
                    params![
                        unit_id,
                        job_id,
                        node.id,
                        chunk_revision,
                        project_id,
                        node.origin_kind,
                        OVERSIZED_GRAPHEME,
                        json_array(&source_ids)?,
                    ],
                )
                .map_err(db_error)?;
            }
        }
    }
    Ok(desired)
}

#[derive(Default)]
struct Claim {
    statement: Option<String>,
    condition: Option<String>,
    requirement: Option<Value>,
    polarity: Option<String>,
}

fn claim(tx: &Transaction<'_>, node_id: &str) -> CognitionResult<Claim> {
    let value = tx
        .query_row(
            "SELECT statement,condition,requirement,polarity FROM memory_claims WHERE node_id=?1",
            [node_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()
        .map_err(db_error)?;
    let Some((statement, condition, requirement, polarity)) = value else {
        return Ok(Claim::default());
    };
    Ok(Claim {
        statement: Some(statement),
        condition,
        requirement: requirement
            .map(|value| serde_json::from_str(&value).map_err(json_error))
            .transpose()?,
        polarity: Some(polarity),
    })
}

fn node_projection(
    node_type: &str,
    label: &str,
    claim: &Claim,
    aliases: &[String],
) -> CognitionResult<String> {
    let mut fields = vec![
        format!("type:{}", json_string(Some(node_type))?),
        format!("label:{}", json_string(Some(label))?),
        format!("statement:{}", json_string(claim.statement.as_deref())?),
        format!("condition:{}", json_string(claim.condition.as_deref())?),
    ];
    if claim.requirement.as_ref().is_some_and(js_truthy) {
        fields.push(format!(
            "requirement:{}",
            stringify(claim.requirement.as_ref().expect("checked"))?
        ));
    }
    fields.push(format!(
        "polarity:{}",
        json_string(claim.polarity.as_deref())?
    ));
    for alias in aliases {
        fields.push(format!("alias:{}", json_string(Some(alias))?));
    }
    Ok(fields.join("\n"))
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn aliases(
    tx: &Transaction<'_>,
    node_id: &str,
    episode_id: &str,
    revision: &str,
    origin_kind: &str,
) -> CognitionResult<Vec<String>> {
    let mut statement = tx
        .prepare(
            "SELECT DISTINCT a.surface_original FROM memory_aliases a              JOIN memory_chunk_sources s ON s.source_id=a.source_id              WHERE a.node_id=?1 AND s.episode_id=?2 AND s.revision=?3 AND s.origin_kind=?4              ORDER BY a.surface_original LIMIT 8",
        )
        .map_err(db_error)?;
    statement
        .query_map(params![node_id, episode_id, revision, origin_kind], |row| {
            row.get(0)
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)
}

fn node_source_ids(
    tx: &Transaction<'_>,
    node_id: &str,
    episode_id: &str,
    revision: &str,
    origin_kind: &str,
) -> CognitionResult<Vec<String>> {
    let mut statement = tx
        .prepare(
            "SELECT DISTINCT m.source_id FROM memory_evidence m              JOIN memory_chunk_sources s ON s.source_id=m.source_id              WHERE m.node_id=?1 AND m.episode_id=?2 AND m.revision=?3 AND s.origin_kind=?4              ORDER BY m.source_id",
        )
        .map_err(db_error)?;
    statement
        .query_map(params![node_id, episode_id, revision, origin_kind], |row| {
            row.get(0)
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)
}

fn retain_receipt(
    tx: &Transaction<'_>,
    unit_id: &str,
    kind: &str,
    owner_id: &str,
    owner_revision: &str,
    project_id: Option<&str>,
    origin_kind: &str,
) -> CognitionResult<()> {
    let prior = tx
        .query_row(
            "SELECT receipt_json FROM memory_vector_units              WHERE record_kind=?1 AND owner_id=?2 AND owner_revision=?3 AND project_id IS ?4                AND origin_kind=?5 AND state='complete' AND unit_id!=?6 AND receipt_json IS NOT NULL              ORDER BY unit_id LIMIT 1",
            params![kind, owner_id, owner_revision, project_id, origin_kind, unit_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?;
    if let Some(receipt) = prior {
        tx.execute(
            "UPDATE memory_vector_units SET receipt_json=?1,error_code='memory_vector_reuse_pending'              WHERE unit_id=?2 AND state='pending'",
            params![receipt, unit_id],
        )
        .map_err(db_error)?;
    }
    Ok(())
}
