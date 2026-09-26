//! Canonical source-backed candidate hydration and currentness.

use super::*;
use crate::cognition::graph::{input, plan::NormalizedPlan};
use indexmap::IndexSet;
use rusqlite::OptionalExtension;
use serde_json::json;

pub(in crate::cognition::graph) fn assert_current(
    db: &Connection,
    canonical: &ConversationSourceReader,
    source_root: &std::path::Path,
    input: &ExtractInput,
    plan: &NormalizedPlan,
) -> CognitionResult<()> {
    for binding in plan.candidate_bindings.values() {
        for evidence in &binding.evidence {
            let eligible = db
                .query_row(
                    "SELECT 1
                     FROM memory_chunk_sources s
                     JOIN memory_chunks c ON c.memory_chunk_id = s.episode_id
                         AND c.current_revision = s.revision
                     WHERE s.source_id = ?1 AND c.status = 'active'
                       AND ((?2 = 'project' AND c.project_id IS ?3)
                         OR (?2 = 'user' AND (c.project_id IS NULL OR c.project_id IS ?4)))
                     LIMIT 1",
                    params![
                        evidence.source_ref,
                        binding.scope,
                        binding.project_id,
                        input.bound_project_id
                    ],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
                .map_err(db_error)?;
            if eligible.is_none() {
                return Err(error("memory_extract_candidate_changed"));
            }
            let row = input::source_row(db, &evidence.source_ref)?
                .ok_or_else(|| error("memory_extract_candidate_changed"))?;
            if row.episode_id != evidence.episode_ref
                || row.revision != evidence.revision
                || row.content_hash != evidence.content_hash
            {
                return Err(error("memory_extract_candidate_changed"));
            }
            if matches!(row.source_kind.as_str(), "task_report" | "explicit_record") {
                crate::cognition::sources::hydrate_typed_source(source_root, &row)
                    .map_err(|_| error("memory_extract_candidate_changed"))?;
                continue;
            }
            let message_id = row
                .conversation_message_id
                .as_deref()
                .ok_or_else(|| error("memory_extract_candidate_changed"))?;
            let message = canonical
                .read_message(message_id)
                .map_err(|_| error("memory_extract_candidate_changed"))?
                .ok_or_else(|| error("memory_extract_candidate_changed"))?;
            crate::cognition::hydrate_conversation_source(&message, &row, f64::INFINITY)
                .map_err(|_| error("memory_extract_candidate_changed"))?;
        }
    }
    Ok(())
}

pub(super) fn hydrate(
    db: &Connection,
    canonical: &ConversationSourceReader,
    source_root: &std::path::Path,
    input: &ExtractInput,
    id: &str,
    source_only: bool,
) -> CognitionResult<Option<ExtractCandidate>> {
    let node = db
        .query_row(
            "SELECT n.type, n.identity_scope, n.project_id
             FROM memory_nodes n
             LEFT JOIN memory_projection_windows w ON w.window_ref = n.window_ref
             WHERE n.id = ?1 AND (w.window_ref IS NULL OR w.state = 'complete')",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(db_error)?;
    let Some((node_type, scope, project_id)) = node else {
        return Ok(None);
    };
    let identity = node_type == "entity" || node_type == "project";
    if !identity
        && (if input.bound_project_id.is_none() {
            scope != "user" || project_id.is_some()
        } else {
            scope != "project" || project_id.as_deref() != input.bound_project_id.as_deref()
        })
    {
        return Ok(None);
    }
    let source_filter = if source_only {
        "s.origin_kind IN ('user_input', 'assistant_public')"
    } else {
        "(s.origin_kind IN ('user_input', 'assistant_public') \
         OR (s.source_kind='task_report' AND s.role='task' AND s.basis='reviewed_task') \
         OR (s.source_kind='explicit_record' AND s.role='explicit' AND s.basis='user_statement'))"
    };
    let mut aliases = db
        .prepare(&format!(
            "SELECT DISTINCT a.surface_original, a.source_id
             FROM memory_aliases a
             JOIN memory_chunk_sources s ON s.source_id = a.source_id
             JOIN memory_chunks c ON c.memory_chunk_id = s.episode_id
                 AND c.current_revision = s.revision
             WHERE a.node_id = ?1 AND {source_filter}
               AND (c.project_id IS NULL OR c.project_id IS ?2)
             ORDER BY a.surface_original, a.source_id
             LIMIT 3"
        ))
        .map_err(db_error)?;
    let aliases = aliases
        .query_map(params![id, input.bound_project_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    if aliases.is_empty() {
        return Ok(None);
    }
    let mut evidence = Vec::new();
    let mut sources = HashSet::new();
    for (_, source) in &aliases {
        if !sources.insert(source.clone()) || evidence.len() >= 2 {
            continue;
        }
        let Some(row) = input::source_row(db, source)? else {
            return Ok(None);
        };
        let text = if matches!(row.source_kind.as_str(), "task_report" | "explicit_record") {
            crate::cognition::sources::hydrate_typed_source(source_root, &row)?
        } else {
            let Some(message_id) = row.conversation_message_id.as_deref() else {
                return Ok(None);
            };
            let message = canonical
                .read_message(message_id)
                .map_err(crate::cognition::CognitionError::from)?
                .ok_or_else(|| error("memory_source_changed"))?;
            crate::cognition::hydrate_conversation_source(&message, &row, f64::INFINITY)?
                .text
                .to_owned()
        };
        evidence.push(crate::cognition::extraction::CandidateEvidence {
            ref_id: source.clone(),
            text,
            observed_at: row.observed_at,
            basis: row.basis,
        });
    }
    let claim = if identity {
        None
    } else {
        let value = db
            .query_row(
                "SELECT statement, polarity, condition FROM memory_claims WHERE node_id = ?1",
                [id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<String>>(1)?,
                        r.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(db_error)?;
        let Some((statement, polarity, condition)) = value else {
            return Ok(None);
        };
        let mut edges = db
            .prepare(
                "SELECT rel_type, target_node_id
                 FROM edges
                 WHERE source_node_id = ?1 AND rel_type IN ('has_subject', 'has_object')
                 ORDER BY edge_id",
            )
            .map_err(db_error)?;
        let edges = edges
            .query_map([id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        let relation = db
            .query_row(
                "SELECT rel_type
                 FROM edges
                 WHERE claim_node_id = ?1
                   AND rel_type NOT IN ('has_subject', 'has_object', 'supersedes',
                       'contradicts', 'condition_member', 'identity_match', 'same_claim', 'refines')
                 ORDER BY edge_id
                 LIMIT 1",
                [id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(db_error)?;
        Some(
            json!({"statement":statement,"subject_ref":edges.iter().find(|x|x.0=="has_subject").map(|x|&x.1),
            "object_ref":edges.iter().find(|x|x.0=="has_object").map(|x|&x.1),"relation":relation,
            "polarity":polarity,"condition":condition}),
        )
    };
    let label = aliases[0].0.clone();
    Ok(Some(ExtractCandidate {
        ref_id: id.into(),
        node_type,
        label: label.clone(),
        aliases: aliases
            .iter()
            .map(|x| x.0.clone())
            .collect::<IndexSet<_>>()
            .into_iter()
            .filter(|a| identity || a != &label)
            .collect(),
        scope,
        project_id,
        claim,
        evidence,
    }))
}
