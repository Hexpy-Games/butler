//! Current-unit, source-scope and event second filter for optional vector hits.

use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
};

use rusqlite::{Connection, OptionalExtension, params, params_from_iter, types::Value};
use sha2::{Digest, Sha256};

use crate::cognition::{
    CognitionResult, MemoryGenerationHandle,
    recall::{RecallRequest, RecallVectorMatch, RecallVectorMatches},
};

use super::{db_error, scope};

#[cfg(test)]
mod tests;

#[derive(Default)]
pub(in crate::cognition) struct CurrentVectorMatches {
    pub nodes: Vec<RecallVectorMatch>,
    pub episodes: Vec<RecallVectorMatch>,
    pub partial: bool,
}

pub(super) fn current(
    db: &Connection,
    input: &RecallRequest,
    generation: &MemoryGenerationHandle,
    matches: &RecallVectorMatches,
    parse_date: &dyn Fn(&str) -> f64,
) -> CognitionResult<CurrentVectorMatches> {
    let mut partial = matches.diagnostics.iter().any(|code| {
        code.ends_with("_vector_bound_reached")
            || code.starts_with("vector_rows_invalid=")
            || code.contains("_omitted=")
    });
    let nodes = filter(
        db,
        input,
        generation,
        &matches.nodes,
        "node",
        parse_date,
        &mut partial,
    )?;
    let episodes = filter(
        db,
        input,
        generation,
        &matches.episodes,
        "episode",
        parse_date,
        &mut partial,
    )?;
    if super::coverage::vector_incomplete(db, input, &generation.generation_id)? {
        partial = true;
    }
    Ok(CurrentVectorMatches {
        nodes,
        episodes,
        partial,
    })
}

#[allow(clippy::too_many_arguments)]
fn filter(
    db: &Connection,
    input: &RecallRequest,
    generation: &MemoryGenerationHandle,
    values: &[RecallVectorMatch],
    kind: &str,
    parse_date: &dyn Fn(&str) -> f64,
    partial: &mut bool,
) -> CognitionResult<Vec<RecallVectorMatch>> {
    let mut rejected = HashSet::new();
    let mut best = HashMap::<String, RecallVectorMatch>::new();
    for original in values {
        let expected = digest(&[
            "memory-vector",
            &original.generation,
            kind,
            &original.owner_id,
            &original.owner_revision,
            &original.embedding_chunk_id,
            &original.embedding_version,
        ]);
        if original.generation != generation.generation_id
            || generation
                .embedding
                .as_ref()
                .is_none_or(|embedding| embedding.version() != original.embedding_version)
            || original.vector_key != expected
            || !original.distance.is_finite()
        {
            rejected.insert(original.owner_id.as_str());
            continue;
        }
        let current = if kind == "node" {
            node_membership(db, input, generation, original)?
        } else if episode_receipt(db, generation, original, parse_date)?
            && event_episode(db, input, &original.owner_id)?
        {
            Some(original.clone())
        } else {
            None
        };
        let Some(current) = current else {
            rejected.insert(original.owner_id.as_str());
            continue;
        };
        let slot = best
            .entry(current.owner_id.clone())
            .or_insert_with(|| current.clone());
        if current.distance < slot.distance
            || (current.distance == slot.distance
                && current.vector_key.as_bytes() < slot.vector_key.as_bytes())
        {
            *slot = current;
        }
    }
    if rejected.iter().any(|owner| !best.contains_key(*owner)) {
        *partial = true;
    }
    let mut ranked = best.into_values().collect::<Vec<_>>();
    ranked.sort_by(|a, b| {
        a.distance
            .partial_cmp(&b.distance)
            .unwrap_or(Ordering::Equal)
            .then_with(|| a.owner_id.as_bytes().cmp(b.owner_id.as_bytes()))
    });
    let limit = if kind == "node" { 64 } else { 128 };
    if ranked.len() > limit {
        *partial = true;
    }
    ranked.truncate(limit);
    for (index, value) in ranked.iter_mut().enumerate() {
        value.rank = index + 1;
    }
    Ok(ranked)
}

fn digest(values: &[&str]) -> String {
    let json = serde_json::to_string(values).expect("string digest array");
    format!("{:x}", Sha256::digest(json.as_bytes()))
}

fn node_membership(
    db: &Connection,
    input: &RecallRequest,
    generation: &MemoryGenerationHandle,
    hit: &RecallVectorMatch,
) -> CognitionResult<Option<RecallVectorMatch>> {
    let source = scope::source(input, "s", "c");
    let event = scope::event_episode(input, "j.episode_id");
    let sql = format!(
        r#"
        SELECT j.episode_id,j.revision,u.source_ids_json,COALESCE(c.project_id,''),
          s.origin_kind,s.source_kind,s.conversation_session_id,s.observed_at
        FROM memory_vector_units u
        JOIN memory_projection_jobs j ON j.job_id=u.job_id AND j.generation=?
        JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision
        JOIN json_each(u.source_ids_json) refs
        JOIN memory_chunk_sources s ON s.source_id=refs.value AND s.episode_id=j.episode_id
          AND s.revision=j.revision
        JOIN memory_evidence m ON m.node_id=u.owner_id AND m.source_id=s.source_id
          AND m.episode_id=j.episode_id AND m.revision=j.revision
        WHERE u.record_kind='node' AND u.owner_id=? AND u.owner_revision=? AND u.state='complete'
          AND EXISTS(SELECT 1 FROM json_each(json_extract(u.receipt_json,'$.vector_keys')) keys
            WHERE keys.value=?) AND {} {}
        ORDER BY julianday(s.observed_at),s.source_id,j.episode_id LIMIT 1
    "#,
        source.sql, event.sql
    );
    let mut args = vec![
        Value::Text(generation.generation_id.clone()),
        Value::Text(hit.owner_id.clone()),
        Value::Text(hit.owner_revision.clone()),
        Value::Text(hit.vector_key.clone()),
    ];
    args.extend(source.args);
    args.extend(event.args);
    db.query_row(&sql, params_from_iter(args), |row| {
        let mut current = hit.clone();
        current.source_episode_id = Some(row.get(0)?);
        current.source_revision = row.get(1)?;
        current.source_refs_json = row.get(2)?;
        current.project_id = row.get(3)?;
        current.origin_kind = row.get(4)?;
        current.source_kind = row.get(5)?;
        current.conversation_session_id = row.get(6)?;
        current.source_observed_at = row.get(7)?;
        Ok(current)
    })
    .optional()
    .map_err(db_error)
}

fn episode_receipt(
    db: &Connection,
    generation: &MemoryGenerationHandle,
    hit: &RecallVectorMatch,
    parse_date: &dyn Fn(&str) -> f64,
) -> CognitionResult<bool> {
    let mut statement = db
        .prepare(
            r#"
        SELECT COALESCE(u.project_id,''),u.origin_kind,c.conversation_session_id,
          (SELECT ordered.observed_at FROM memory_chunk_sources ordered
           WHERE ordered.episode_id=c.memory_chunk_id AND ordered.revision=c.current_revision
             AND (u.source_ids_json IS NULL OR ordered.source_id IN
               (SELECT value FROM json_each(u.source_ids_json)))
           ORDER BY julianday(ordered.observed_at) DESC,ordered.source_id DESC LIMIT 1),
          COALESCE(u.source_ids_json,(SELECT json_group_array(source_id) FROM (
            SELECT ordered.source_id FROM memory_chunk_sources ordered
            WHERE ordered.episode_id=c.memory_chunk_id AND ordered.revision=c.current_revision
            ORDER BY julianday(ordered.observed_at),ordered.conversation_message_id,
              ordered.part_id,ordered.scalar_pointer,ordered.byte_start)))
        FROM memory_vector_units u JOIN memory_projection_jobs j ON j.job_id=u.job_id
        JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision
        WHERE u.record_kind='episode' AND u.owner_id=?1 AND u.owner_revision=?2
          AND j.revision=?3 AND j.generation=?4 AND u.state='complete'
          AND EXISTS(SELECT 1 FROM json_each(json_extract(u.receipt_json,'$.vector_keys')) keys
            WHERE keys.value=?5)
        ORDER BY u.unit_id
    "#,
        )
        .map_err(db_error)?;
    let mut rows = statement
        .query(params![
            hit.owner_id,
            hit.owner_revision,
            hit.source_revision,
            generation.generation_id,
            hit.vector_key
        ])
        .map_err(db_error)?;
    while let Some(row) = rows.next().map_err(db_error)? {
        let project: String = row.get(0).map_err(db_error)?;
        let origin: String = row.get(1).map_err(db_error)?;
        let session: Option<String> = row.get(2).map_err(db_error)?;
        let observed: Option<String> = row.get(3).map_err(db_error)?;
        let refs: String = row.get(4).map_err(db_error)?;
        if project == hit.project_id
            && origin == hit.origin_kind
            && session == hit.conversation_session_id
            && refs == hit.source_refs_json
            && observed.as_deref().is_some_and(|value| {
                parse_date(value).is_finite()
                    && parse_date(value) == parse_date(&hit.source_observed_at)
            })
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn event_episode(
    db: &Connection,
    input: &RecallRequest,
    episode_id: &str,
) -> CognitionResult<bool> {
    let event = scope::event_episode(input, "c.memory_chunk_id");
    if event.sql.is_empty() {
        return Ok(true);
    }
    let sql = format!(
        "SELECT 1 FROM memory_chunks c WHERE c.memory_chunk_id=? {} LIMIT 1",
        event.sql
    );
    let mut args = vec![Value::Text(episode_id.into())];
    args.extend(event.args);
    Ok(db
        .query_row(&sql, params_from_iter(args), |_| Ok(()))
        .optional()
        .map_err(db_error)?
        .is_some())
}
