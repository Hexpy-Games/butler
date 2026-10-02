//! Indexed alias queries and relationship hops in one read-only generation snapshot.
use std::{collections::HashSet, path::Path};

use rusqlite::{Connection, params};
use serde_json::{Value, json};

use super::{Entity, LegacyGraphReadError, entity_row, entity_value};
use crate::cognition::{
    CognitionCode, CognitionError, CognitionPathEnvironment, graph::GraphRecallReader, lexical,
    resolve_active_generation,
};

fn generation_error(error: CognitionError) -> LegacyGraphReadError {
    LegacyGraphReadError::GenerationUnavailable(error.into())
}

pub(super) fn read(
    data_root: &Path,
    paths: &CognitionPathEnvironment,
    query: &str,
    entity_type: Option<&str>,
    project: Option<&str>,
    max_hops: u32,
) -> Result<String, LegacyGraphReadError> {
    let generation = resolve_active_generation(data_root, paths).map_err(generation_error)?;
    let graph = GraphRecallReader::open(&generation.graph_path).map_err(generation_error)?;
    let db = graph.connection().map_err(generation_error)?;
    let matches = find(db, query, entity_type, project)?;
    let mut entities = Vec::<Value>::new();
    let mut relationships = Vec::new();
    let mut seen = HashSet::new();
    for entity in matches.iter().take(5) {
        if seen.insert(entity.id.clone()) {
            entities.push(entity_value(entity)?);
        }
        for related in related(db, &entity.id, project, max_hops)? {
            if seen.insert(related.id.clone()) {
                entities.push(entity_value(&related)?);
            }
            relationships.push(json!({"from":entity.id,"to":related.id,"hops":related.hops}));
        }
    }
    let current = resolve_active_generation(data_root, paths).map_err(generation_error)?;
    if current.generation_id != generation.generation_id {
        return Err(generation_error(CognitionError::new(
            CognitionCode::MemoryGenerationChanged,
            "memory_generation_changed",
        )));
    }
    graph.close().map_err(generation_error)?;
    Ok(serde_json::to_string_pretty(
        &json!({"entities":entities,"relationships":relationships}),
    )?)
}

fn find(
    db: &Connection,
    query: &str,
    entity_type: Option<&str>,
    project: Option<&str>,
) -> rusqlite::Result<Vec<Entity>> {
    let folded = lexical::case_fold(query.trim());
    if folded.is_empty() {
        return Ok(Vec::new());
    }
    let gram = lexical::folded_grams(&folded).pop();
    // Short cues use the exact folded-alias index; longer cues also use the
    // existing postings index for substring candidates, never a node scan.
    let mut statement = db.prepare(
        "WITH candidates AS (
            SELECT node_id,source_id FROM memory_aliases WHERE folded_key=?1
            UNION
            SELECT node_id,source_id FROM memory_alias_postings WHERE gram=?2
         )
         SELECT DISTINCT n.id,n.type,n.label_original,n.project_id,'{}'
         FROM candidates p JOIN memory_nodes n ON n.id=p.node_id
         JOIN memory_aliases a ON a.node_id=p.node_id AND a.source_id=p.source_id
         JOIN memory_chunk_sources s ON s.source_id=p.source_id
         JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
         WHERE instr(a.folded_key,?1)>0 AND c.status='active'
           AND n.canonical_node_id IS NULL
           AND (?3 IS NULL OR n.type=?3) AND (?4 IS NULL OR n.project_id=?4)
         ORDER BY n.id LIMIT 20",
    )?;
    statement
        .query_map(params![folded, gram, entity_type, project], entity_row)?
        .collect()
}

fn related(
    db: &Connection,
    node_id: &str,
    project: Option<&str>,
    max_hops: u32,
) -> rusqlite::Result<Vec<Entity>> {
    let mut statement = db.prepare(
        "WITH RECURSIVE traversal(id,hops) AS (
            SELECT ?1,0 UNION
            SELECT e.target_node_id,t.hops+1 FROM traversal t JOIN edges e ON e.source_node_id=t.id
              JOIN memory_nodes n ON n.id=e.target_node_id
              WHERE t.hops<?2 AND e.status='active' AND (?3 IS NULL OR n.project_id=?3)
            UNION
            SELECT e.source_node_id,t.hops+1 FROM traversal t JOIN edges e ON e.target_node_id=t.id
              JOIN memory_nodes n ON n.id=e.source_node_id
              WHERE t.hops<?2 AND e.status='active' AND (?3 IS NULL OR n.project_id=?3)
         )
         SELECT n.id,n.type,n.label_original,n.project_id,'{}',MIN(t.hops)
         FROM traversal t JOIN memory_nodes n ON n.id=t.id
         WHERE n.id!=?1 AND n.canonical_node_id IS NULL
         GROUP BY n.id ORDER BY MIN(t.hops),n.id",
    )?;
    statement
        .query_map(params![node_id, max_hops, project], |row| {
            let mut entity = entity_row(row)?;
            entity.hops = row.get(5)?;
            Ok(entity)
        })?
        .collect()
}
