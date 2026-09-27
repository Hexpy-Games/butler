//! Read-only graph evidence for stable node-vector representatives.

use rusqlite::{Connection, params};

use super::{GraphRepository, VectorReadinessRow, db_error};
use crate::cognition::CognitionResult;

#[derive(Default)]
pub(in crate::cognition) struct VectorRepresentativeEvidence {
    pub(in crate::cognition) current_complete: Vec<VectorReadinessRow>,
    pub(in crate::cognition) superseded: Vec<VectorReadinessRow>,
}

impl GraphRepository {
    pub(in crate::cognition) fn load_vector_representative_evidence(
        &self,
        generation: &str,
    ) -> CognitionResult<VectorRepresentativeEvidence> {
        load(self.connection()?, generation)
    }
}

fn load(
    connection: &Connection,
    generation: &str,
) -> CognitionResult<VectorRepresentativeEvidence> {
    Ok(VectorRepresentativeEvidence {
        current_complete: load_state(connection, generation, "complete")?,
        superseded: load_state(connection, generation, "superseded")?,
    })
}

fn load_state(
    connection: &Connection,
    generation: &str,
    state: &str,
) -> CognitionResult<Vec<VectorReadinessRow>> {
    let mut statement = connection
        .prepare(
            "SELECT u.unit_id,u.record_kind,u.owner_id,u.owner_revision,u.projection_text, \
             u.project_id,u.origin_kind,u.receipt_json,j.revision source_revision, \
             c.conversation_session_id, \
             (SELECT ordered.source_kind FROM memory_chunk_sources ordered \
               WHERE ordered.episode_id=c.memory_chunk_id AND ordered.revision=c.current_revision \
               ORDER BY ordered.source_id LIMIT 1) source_kind, \
             (SELECT ordered.observed_at FROM memory_chunk_sources ordered \
               WHERE ordered.episode_id=c.memory_chunk_id AND ordered.revision=c.current_revision \
                 AND (u.source_ids_json IS NULL OR ordered.source_id IN \
                   (SELECT value FROM json_each(u.source_ids_json))) \
                 AND (u.record_kind='episode' OR (ordered.origin_kind=u.origin_kind AND EXISTS( \
                   SELECT 1 FROM memory_evidence own WHERE own.source_id=ordered.source_id \
                     AND own.node_id=u.owner_id))) \
               ORDER BY julianday(ordered.observed_at) DESC,ordered.source_id DESC LIMIT 1) \
               source_observed_at, \
             COALESCE(u.source_ids_json,(SELECT json_group_array(source_id) FROM ( \
               SELECT source_id FROM memory_chunk_sources ordered \
               WHERE ordered.episode_id=c.memory_chunk_id \
                 AND ordered.revision=c.current_revision AND (u.record_kind='episode' OR \
                   (ordered.origin_kind=u.origin_kind AND EXISTS(SELECT 1 FROM memory_evidence own \
                     WHERE own.source_id=ordered.source_id AND own.node_id=u.owner_id))) \
               ORDER BY julianday(ordered.observed_at),ordered.conversation_message_id, \
                 ordered.part_id,ordered.scalar_pointer,ordered.byte_start))) source_ids_json, \
             CASE WHEN NOT (u.project_id IS c.project_id) \
               OR u.source_ids_json IS NULL OR json_array_length(u.source_ids_json)=0 \
               OR EXISTS(SELECT 1 FROM json_each(u.source_ids_json) refs WHERE NOT EXISTS( \
                 SELECT 1 FROM memory_chunk_sources current_source \
                 WHERE current_source.source_id=refs.value \
                   AND current_source.episode_id=c.memory_chunk_id \
                   AND current_source.revision=c.current_revision \
                   AND (u.record_kind!='node' OR (current_source.origin_kind=u.origin_kind \
                     AND EXISTS(SELECT 1 FROM memory_evidence current_mention \
                       WHERE current_mention.node_id=u.owner_id \
                         AND current_mention.source_id=current_source.source_id \
                         AND current_mention.episode_id=c.memory_chunk_id \
                         AND current_mention.revision=c.current_revision))) \
               )) THEN 1 ELSE 0 END source_membership_invalid \
             FROM memory_vector_units u \
             JOIN memory_projection_jobs j ON j.job_id=u.job_id \
             JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id \
               AND c.current_revision=j.revision \
             WHERE j.generation=?1 AND u.state=?2 \
             ORDER BY u.unit_id",
        )
        .map_err(db_error)?;
    let rows = statement
        .query_map(params![generation, state], |row| {
            Ok(VectorReadinessRow {
                unit_id: row.get(0)?,
                record_kind: row.get(1)?,
                owner_id: row.get(2)?,
                owner_revision: row.get(3)?,
                projection_text: row.get(4)?,
                project_id: row.get(5)?,
                origin_kind: row.get(6)?,
                receipt_json: row.get(7)?,
                source_revision: row.get(8)?,
                conversation_session_id: row.get(9)?,
                source_kind: row.get(10)?,
                source_observed_at: row.get(11)?,
                source_ids_json: row.get(12)?,
                source_membership_invalid: row.get::<_, i64>(13)? != 0,
            })
        })
        .map_err(db_error)?;
    let mut selected = Vec::new();
    for row in rows {
        selected.push(row.map_err(db_error)?);
    }
    Ok(selected)
}
