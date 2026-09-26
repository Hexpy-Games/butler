use rusqlite::{Connection, params_from_iter, types::Value};
use serde::Deserialize;

use crate::cognition::{
    CognitionError, CognitionResult,
    recall::{RecallRequest, RecallRequirement},
};

use super::super::{db_error, scope};

#[derive(Deserialize)]
struct RequirementValue {
    action: String,
    condition: crate::json::JsonDocument,
}

pub(super) fn requirements(
    db: &Connection,
    input: &RecallRequest,
    refs: &[(String, String)],
) -> CognitionResult<Vec<RecallRequirement>> {
    if refs.is_empty() {
        return Ok(Vec::new());
    }
    let ids = refs.iter().map(|(id, _)| id).collect::<Vec<_>>();
    let validity = scope::claim(input, "e", "id");
    let source = scope::source(input, "s", "c");
    let sql = format!(
        r#"
        SELECT DISTINCT e.id,m.source_id FROM memory_nodes e
        JOIN memory_evidence m ON m.node_id=e.id
        JOIN memory_chunk_sources s ON s.source_id=m.source_id
        JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id
          AND c.current_revision=s.revision
        WHERE m.source_id IN ({})
          AND (SELECT requirement FROM memory_claims WHERE node_id=e.id) IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM memory_evidence dependency
            WHERE dependency.node_id=e.id AND dependency.source_id NOT IN ({})
          ) AND {} AND {}
    "#,
        scope::placeholders(ids.len()),
        scope::placeholders(ids.len()),
        validity.sql,
        source.sql
    );
    let mut args = ids
        .iter()
        .map(|id| Value::Text((*id).clone()))
        .collect::<Vec<_>>();
    args.extend(ids.iter().map(|id| Value::Text((*id).clone())));
    args.extend(validity.args);
    args.extend(source.args);
    let mut statement = db.prepare(&sql).map_err(db_error)?;
    let rows = statement
        .query_map(params_from_iter(args), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    let mut result = Vec::<RecallRequirement>::new();
    let mut claim = db
        .prepare("SELECT requirement,basis FROM memory_claims WHERE node_id=?")
        .map_err(db_error)?;
    for (node_id, source_id) in rows {
        let (json, basis): (Option<String>, String) = claim
            .query_row([&node_id], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(db_error)?;
        let Some(json) = json else { continue };
        let value: RequirementValue = serde_json::from_str(&json).map_err(|_| {
            CognitionError::new("memory_graph_unavailable", "memory_graph_unavailable")
        })?;
        let Some(reference) = refs
            .iter()
            .find(|(id, _)| id == &source_id)
            .map(|(_, reference)| reference.clone())
        else {
            continue;
        };
        if let Some(existing) = result.iter_mut().find(|item| item.node_ref == node_id) {
            if !existing.source_refs.contains(&reference) {
                existing.source_refs.push(reference);
            }
        } else {
            result.push(RecallRequirement {
                node_ref: node_id,
                action: value.action,
                condition: value.condition,
                basis,
                source_refs: vec![reference],
            });
        }
    }
    Ok(result)
}
