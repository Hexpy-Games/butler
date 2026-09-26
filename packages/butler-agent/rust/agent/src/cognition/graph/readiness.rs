//! Read-only source lineage and canonical evidence for a rebuild candidate.

mod cache;
mod stages;
pub(in crate::cognition) use stages::{CacheReadinessRow, StageReadiness, VectorReadinessRow};

use std::collections::{HashMap, HashSet};
use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use super::{GraphRepository, db_error, vector_registration::source_row};
use crate::cognition::{CognitionResult, CognitionSourceRow, sources::hydrate_typed_source};
use crate::conversation::ConversationSourceReader;

const SOURCE_COLUMNS: &str = "source_id,episode_id,revision,source_kind,conversation_session_id,conversation_message_id,part_id,scalar_pointer,byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis";

#[derive(Default)]
pub(in crate::cognition) struct SourceReadiness {
    pub registered: usize,
    pub expected_count: usize,
    pub unexpected: usize,
    pub semantic_invalid: usize,
    pub graph_invalid: usize,
    pub canonical_invalid: usize,
    pub processing: HashSet<String>,
    pub historical: HashSet<String>,
}

struct Expected {
    revision: String,
    hashes: HashSet<String>,
    origins: Option<HashSet<String>>,
}

impl GraphRepository {
    pub(in crate::cognition) fn rebuild_source_readiness(
        &self,
        generation: &str,
        inventory: &Value,
        canonical: &ConversationSourceReader,
        source_root: &Path,
    ) -> CognitionResult<SourceReadiness> {
        let db = self.connection()?;
        let expected = expected_sources(inventory)?;
        let registered_rows = registered_leaves(db, generation)?;
        let mut result = SourceReadiness {
            expected_count: expected.len(),
            ..Default::default()
        };
        for (source_id, item) in &expected {
            let Some(root) = source(db, source_id)? else {
                continue;
            };
            if root.revision != item.revision
                || !item.hashes.contains(&root.content_hash)
                || item
                    .origins
                    .as_ref()
                    .is_some_and(|origins| !origins.contains(&root.origin_kind))
            {
                continue;
            }
            let mut visited = HashSet::new();
            let Some((leaves, all)) = lineage(db, &root, item.origins.as_ref(), &mut visited)?
            else {
                continue;
            };
            if leaves.iter().all(|id| registered_rows.contains(id)) {
                result.registered += 1;
            }
            result.processing.extend(leaves);
            result.historical.extend(all);
        }
        result.unexpected = registered_rows.difference(&result.processing).count();
        result.semantic_invalid = semantic_invalid(db, generation, &result.processing)?;
        result.graph_invalid = graph_invalid(db, generation)?;
        for source_id in &result.historical {
            let Some(row) = source(db, source_id)? else {
                result.canonical_invalid += 1;
                continue;
            };
            if !hydrate(canonical, source_root, &row) {
                result.canonical_invalid += 1;
            }
        }
        Ok(result)
    }
}

fn expected_sources(inventory: &Value) -> CognitionResult<HashMap<String, Expected>> {
    let mut expected = HashMap::new();
    for entry in array(inventory, "entries")? {
        let revision = string(entry, "revision")?.to_owned();
        let hashes = string_array(entry, "sourceHashes")?
            .into_iter()
            .collect::<HashSet<_>>();
        let origins = Some(
            string_array(entry, "originKinds")?
                .into_iter()
                .collect::<HashSet<_>>(),
        );
        for id in string_array(entry, "sourceIds")? {
            expected.insert(
                id,
                Expected {
                    revision: revision.clone(),
                    hashes: hashes.clone(),
                    origins: origins.clone(),
                },
            );
        }
    }
    for entry in array(inventory, "typed")? {
        let revision = string(entry, "revision")?.to_owned();
        let hashes = HashSet::from([string(entry, "content_hash")?.to_owned()]);
        for id in string_array(entry, "source_ids")? {
            expected.insert(
                id,
                Expected {
                    revision: revision.clone(),
                    hashes: hashes.clone(),
                    origins: None,
                },
            );
        }
    }
    Ok(expected)
}

fn registered_leaves(db: &Connection, generation: &str) -> CognitionResult<HashSet<String>> {
    let mut statement = db.prepare("SELECT s.source_id FROM memory_source_leaves s JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision JOIN memory_projection_jobs j ON j.episode_id=c.memory_chunk_id AND j.revision=c.current_revision WHERE j.generation=?1").map_err(db_error)?;
    statement
        .query_map([generation], |row| row.get::<_, String>(0))
        .map_err(db_error)?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(db_error)
}

fn source(db: &Connection, id: &str) -> CognitionResult<Option<CognitionSourceRow>> {
    db.query_row(
        &format!("SELECT {SOURCE_COLUMNS} FROM memory_chunk_sources WHERE source_id=?1"),
        [id],
        source_row,
    )
    .optional()
    .map_err(db_error)
}

fn lineage(
    db: &Connection,
    root: &CognitionSourceRow,
    origins: Option<&HashSet<String>>,
    visited: &mut HashSet<String>,
) -> CognitionResult<Option<(Vec<String>, Vec<String>)>> {
    if !visited.insert(root.source_id.clone())
        || visited.len() > 4096
        || origins.is_some_and(|allowed| !allowed.contains(&root.origin_kind))
    {
        return Ok(None);
    }
    let children_json = db
        .query_row(
            "SELECT child_source_ids_json FROM memory_source_split_parents WHERE source_id=?1",
            [&root.source_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?;
    let Some(children_json) = children_json else {
        return Ok(Some((
            vec![root.source_id.clone()],
            vec![root.source_id.clone()],
        )));
    };
    let Ok(ids) = serde_json::from_str::<Vec<String>>(&children_json) else {
        return Ok(None);
    };
    if ids.is_empty() || ids.len() > 4096 || ids.iter().collect::<HashSet<_>>().len() != ids.len() {
        return Ok(None);
    }
    let mut children = Vec::with_capacity(ids.len());
    for id in ids {
        let Some(child) = source(db, &id)? else {
            return Ok(None);
        };
        if child.episode_id != root.episode_id
            || child.revision != root.revision
            || child.content_hash != root.content_hash
            || child.source_kind != root.source_kind
            || child.part_id != root.part_id
            || child.scalar_pointer != root.scalar_pointer
            || child.origin_kind != root.origin_kind
            || child.byte_start < root.byte_start
            || child.byte_end > root.byte_end
            || child.byte_start >= child.byte_end
        {
            return Ok(None);
        }
        children.push(child);
    }
    children.sort_by(|left, right| {
        left.byte_start
            .total_cmp(&right.byte_start)
            .then_with(|| left.source_id.cmp(&right.source_id))
    });
    if children
        .first()
        .is_none_or(|first| first.byte_start != root.byte_start)
        || children
            .last()
            .is_none_or(|last| last.byte_end != root.byte_end)
        || children
            .windows(2)
            .any(|pair| pair[0].byte_end != pair[1].byte_start)
    {
        return Ok(None);
    }
    let mut leaves = Vec::new();
    let mut all = vec![root.source_id.clone()];
    for child in children {
        let Some((child_leaves, child_all)) = lineage(db, &child, origins, visited)? else {
            return Ok(None);
        };
        leaves.extend(child_leaves);
        all.extend(child_all);
    }
    Ok(Some((leaves, all)))
}

fn hydrate(
    canonical: &ConversationSourceReader,
    source_root: &Path,
    row: &CognitionSourceRow,
) -> bool {
    if matches!(row.source_kind.as_str(), "task_report" | "explicit_record") {
        return hydrate_typed_source(source_root, row).is_ok();
    }
    let Some(message_id) = row.conversation_message_id.as_deref() else {
        return false;
    };
    canonical
        .read_message(message_id)
        .ok()
        .flatten()
        .is_some_and(|message| {
            crate::cognition::hydrate_conversation_source(&message, row, f64::INFINITY).is_ok()
        })
}

fn semantic_invalid(
    db: &Connection,
    generation: &str,
    processing: &HashSet<String>,
) -> CognitionResult<usize> {
    let mut statement = db.prepare("SELECT w.source_refs_json,w.state,w.normalized_plan_json FROM memory_projection_windows w JOIN memory_projection_jobs j ON j.job_id=w.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE j.generation=?1 AND w.state IN ('complete','unsupported')").map_err(db_error)?;
    let rows = statement
        .query_map([generation], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(db_error)?;
    let mut invalid = 0;
    for row in rows {
        let (raw, state, plan) = row.map_err(db_error)?;
        match serde_json::from_str::<Vec<String>>(&raw) {
            Ok(refs)
                if !refs.is_empty()
                    && refs.iter().all(|id| processing.contains(id))
                    && (state != "complete" || plan.is_some()) => {}
            _ => invalid += 1,
        }
    }
    Ok(invalid)
}

fn graph_invalid(db: &Connection, generation: &str) -> CognitionResult<usize> {
    db.query_row("SELECT COUNT(*) FROM edge_evidence ee JOIN edges e ON e.edge_id=ee.edge_id AND e.status='active' LEFT JOIN memory_chunk_sources s ON s.source_id=ee.chunk_source_id LEFT JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision LEFT JOIN memory_projection_jobs j ON j.episode_id=c.memory_chunk_id AND j.revision=c.current_revision AND j.generation=?1 WHERE j.job_id IS NULL", params![generation], |row| row.get::<_, usize>(0)).map_err(db_error)
}

fn array<'a>(value: &'a Value, field: &str) -> CognitionResult<&'a [Value]> {
    value
        .get(field)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or_else(invalid_inventory)
}
fn string<'a>(value: &'a Value, field: &str) -> CognitionResult<&'a str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(invalid_inventory)
}
fn string_array(value: &Value, field: &str) -> CognitionResult<Vec<String>> {
    array(value, field)?
        .iter()
        .map(|item| {
            item.as_str()
                .map(str::to_owned)
                .ok_or_else(invalid_inventory)
        })
        .collect()
}
fn invalid_inventory() -> crate::cognition::CognitionError {
    crate::cognition::CognitionError::new("memory_inventory_changed", "memory_inventory_changed")
}
