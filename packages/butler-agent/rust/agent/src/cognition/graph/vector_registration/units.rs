#[path = "nodes.rs"]
mod nodes;

use std::collections::HashSet;

use rusqlite::{Connection, Transaction, params};
use serde_json::{Value, json};

use super::{
    CognitionError, CognitionResult, EPISODE_CHUNK_BYTES, EpisodeProjectionSource,
    OVERSIZED_GRAPHEME, VectorRegistrationStage, db_error, digest, json_array, json_error,
    stringify,
};
use crate::segmentation::grapheme_segments;

use nodes::{job_chunk, node_rows};

pub(super) fn refresh(
    connection: &mut Connection,
    job_id: &str,
    episode_sources: &[EpisodeProjectionSource],
    now: &str,
) -> Result<(), (VectorRegistrationStage, CognitionError)> {
    let mut stage = VectorRegistrationStage::Node;
    let result = (|| {
        let (episode_id, revision, project_id, origin_kind) = job_chunk(connection, job_id)?;
        let nodes = node_rows(connection, &episode_id, &revision)?;
        let tx = connection.transaction().map_err(db_error)?;
        let desired_nodes = nodes::register(
            &tx,
            job_id,
            &episode_id,
            &revision,
            project_id.as_deref(),
            &nodes,
        )?;
        stage = VectorRegistrationStage::Episode;
        let desired_episodes = register_episodes(
            &tx,
            job_id,
            &episode_id,
            &revision,
            project_id.as_deref(),
            &origin_kind,
            episode_sources,
        )?;
        supersede_obsolete(&tx, job_id, "node", &desired_nodes)?;
        supersede_obsolete(&tx, job_id, "episode", &desired_episodes)?;
        refresh_stage_states(&tx, job_id, now)?;
        tx.commit().map_err(db_error)
    })();
    result.map_err(|error| (stage, error))
}

fn register_episodes(
    tx: &Transaction<'_>,
    job_id: &str,
    episode_id: &str,
    revision: &str,
    project_id: Option<&str>,
    origin_kind: &str,
    sources: &[EpisodeProjectionSource],
) -> CognitionResult<HashSet<String>> {
    let mut desired = HashSet::new();
    for source in sources {
        match chunks(&source.text, EPISODE_CHUNK_BYTES) {
            Ok(chunks) => {
                let mut byte_start = source.byte_start;
                for text in chunks {
                    let byte_end = byte_start + text.len() as i64;
                    let chunk_revision = digest(vec![
                        json!("episode-vector-chunk"),
                        json!(episode_id),
                        json!(revision),
                        json!(source.source_id),
                        json!(byte_start),
                        json!(byte_end),
                        json!(text),
                    ])?;
                    let unit_id = vector_unit_id(job_id, "episode", episode_id, &chunk_revision)?;
                    desired.insert(unit_id.clone());
                    tx.execute(
                        "INSERT OR IGNORE INTO memory_vector_units                          (unit_id,job_id,record_kind,owner_id,owner_revision,project_id,origin_kind,projection_text,source_ids_json,source_byte_start,source_byte_end,source_role)                          VALUES(?1,?2,'episode',?3,?4,?5,?6,?7,?8,?9,?10,?11)",
                        params![
                            unit_id,
                            job_id,
                            episode_id,
                            chunk_revision,
                            project_id,
                            origin_kind,
                            format!("[{}] {}", source.role, text),
                            json_array(std::slice::from_ref(&source.source_id))?,
                            byte_start,
                            byte_end,
                            source.role,
                        ],
                    )
                    .map_err(db_error)?;
                    byte_start = byte_end;
                }
            }
            Err(()) => {
                let chunk_revision = digest(vec![
                    json!("episode-vector-oversized"),
                    json!(episode_id),
                    json!(revision),
                    json!(source.source_id),
                    json!(source.byte_start),
                ])?;
                let unit_id = vector_unit_id(job_id, "episode", episode_id, &chunk_revision)?;
                desired.insert(unit_id.clone());
                let byte_end = source.byte_start + source.text.len() as i64;
                tx.execute(
                        "INSERT OR IGNORE INTO memory_vector_units                      (unit_id,job_id,record_kind,owner_id,owner_revision,project_id,origin_kind,projection_text,state,error_code,source_ids_json,source_byte_start,source_byte_end,source_role)                      VALUES(?1,?2,'episode',?3,?4,?5,?6,'','failed',?7,?8,?9,?10,?11)",
                    params![
                        unit_id,
                        job_id,
                        episode_id,
                        chunk_revision,
                        project_id,
                        origin_kind,
                        OVERSIZED_GRAPHEME,
                        json_array(std::slice::from_ref(&source.source_id))?,
                        source.byte_start,
                        byte_end,
                        source.role,
                    ],
                )
                .map_err(db_error)?;
            }
        }
    }
    Ok(desired)
}

fn vector_unit_id(
    job_id: &str,
    kind: &str,
    owner_id: &str,
    chunk_revision: &str,
) -> CognitionResult<String> {
    digest(vec![
        json!("vector-unit"),
        json!(job_id),
        json!(kind),
        json!(owner_id),
        json!(chunk_revision),
    ])
}

fn supersede_obsolete(
    tx: &Transaction<'_>,
    job_id: &str,
    kind: &str,
    desired: &HashSet<String>,
) -> CognitionResult<()> {
    let mut statement = tx
        .prepare(
            "SELECT unit_id FROM memory_vector_units              WHERE job_id=?1 AND record_kind=?2 AND state!='superseded'",
        )
        .map_err(db_error)?;
    let rows = statement
        .query_map(params![job_id, kind], |row| row.get::<_, String>(0))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    for unit_id in rows {
        if !desired.contains(&unit_id) {
            tx.execute(
                "UPDATE memory_vector_units SET state='superseded',owner_pid=NULL,owner_nonce=NULL,started_at=NULL WHERE unit_id=?1",
                [unit_id],
            )
            .map_err(db_error)?;
        }
    }
    Ok(())
}

fn refresh_stage_states(tx: &Transaction<'_>, job_id: &str, now: &str) -> CognitionResult<()> {
    let semantic = tx
        .query_row(
            "SELECT semantic_graph_state FROM memory_projection_jobs WHERE job_id=?1",
            [job_id],
            |row| row.get::<_, String>(0),
        )
        .map_err(db_error)?;
    let semantic: Value = serde_json::from_str(&semantic).map_err(json_error)?;
    for stage in [
        VectorRegistrationStage::Node,
        VectorRegistrationStage::Episode,
    ] {
        let (total, complete, failed) = tx
            .query_row(
                "SELECT COUNT(*),COALESCE(SUM(state='complete'),0),COALESCE(SUM(state='failed'),0)                  FROM memory_vector_units WHERE job_id=?1 AND record_kind=?2 AND state!='superseded'",
                params![job_id, stage.kind()],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .map_err(db_error)?;
        let pending = total - complete - failed;
        let state = if total == 0
            && stage == VectorRegistrationStage::Node
            && semantic.get("state").and_then(Value::as_str) != Some("complete")
        {
            json!({"state":"pending","blocked_by":"semantic_graph"})
        } else if failed > 0 || (complete > 0 && pending > 0) {
            json!({"state":"partial","completed_units":complete,"total_units":total,"pending_units":pending,"failed_units":failed})
        } else if complete == total {
            json!({"state":"complete","completed_units":complete,"total_units":total})
        } else {
            json!({"state":"pending","blocked_by":null})
        };
        tx.execute(
            &format!(
                "UPDATE memory_projection_jobs SET {}=?1,last_served_at=?2 WHERE job_id=?3",
                stage.column()
            ),
            params![stringify(&state)?, now, job_id],
        )
        .map_err(db_error)?;
    }
    Ok(())
}

pub(super) fn chunks(text: &str, max_bytes: usize) -> Result<Vec<&str>, ()> {
    let mut result = Vec::new();
    let mut start = 0;
    for segment in grapheme_segments(text) {
        if segment.end - segment.start > max_bytes {
            return Err(());
        }
        if segment.end - start > max_bytes {
            result.push(&text[start..segment.start]);
            start = segment.start;
        }
    }
    if start < text.len() {
        result.push(&text[start..]);
    }
    Ok(result)
}

impl VectorRegistrationStage {
    fn kind(self) -> &'static str {
        match self {
            Self::Node => "node",
            Self::Episode => "episode",
        }
    }
}
