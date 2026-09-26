//! Source-scoped SQL lanes feeding the shared recall ranker.

#[cfg(test)]
mod tests;

use rusqlite::{Connection, params};
use std::collections::{HashMap, HashSet};
use unicode_normalization::UnicodeNormalization;

use super::{CognitionResult, ExtractInput, db_error, json_error};
use crate::{
    cognition::{
        lexical,
        recall::{
            Channel, RankedCandidate, SemanticSelection, rank_aliases, rank_lexical,
            select_semantic_seeds,
        },
    },
    conversation::ConversationSourceReader,
};

// Projection uses all-user-sessions, projectFilter:any, includeInternal:false,
// and sourceScope:{projectId: chunk.project_id}. The claim window is as-of.
const ELIGIBLE: &str = "c.status='active' AND ((s.source_kind='conversation' AND s.origin_kind IN ('user_input','assistant_public')) \
 OR (s.source_kind='task_report' AND s.role='task' AND s.basis='reviewed_task') \
 OR (s.source_kind='explicit_record' AND s.role='explicit' AND s.basis='user_statement')) \
 AND (c.project_id IS NULL OR c.project_id IS ?1) AND julianday(s.observed_at)<=julianday(?2) \
 AND (e.type NOT IN ('preference','goal','constraint','decision','memory_atom') OR \
 ((mc.valid_from IS NULL OR julianday(mc.valid_from)<=julianday(?2)) \
 AND (mc.valid_to IS NULL OR julianday(mc.valid_to)>julianday(?2))))";

pub(super) fn select(
    db: &Connection,
    canonical: &ConversationSourceReader,
    input: &ExtractInput,
    cue: &str,
    vector: &[super::VectorHit],
    deadline: i64,
) -> CognitionResult<SemanticSelection> {
    let as_of = input
        .source_units
        .iter()
        .map(|u| u.observed_at.as_str())
        .max()
        .ok_or_else(|| super::error("memory_extract_invalid_input"))?;
    let project = input.bound_project_id.as_deref();
    let mut channels = alias(db, project, as_of, cue)?;
    let (lexical, partial) = lexical(db, project, as_of, cue, deadline)?;
    channels.extend(lexical);
    channels.extend(vectors(db, project, as_of, vector)?);
    let context = context(db, canonical, input, project, as_of)?;
    channels.extend(context);
    Ok(select_semantic_seeds(channels, partial, 32, false, true))
}

fn alias(
    db: &Connection,
    project: Option<&str>,
    as_of: &str,
    cue: &str,
) -> CognitionResult<Vec<RankedCandidate>> {
    let phrase = crate::public_text::trim_js_whitespace(cue);
    if phrase.is_empty() {
        return Ok(Vec::new());
    }
    let nfc = phrase.nfc().collect::<String>();
    let folded = lexical::case_fold(phrase);
    let sql = format!(
        "SELECT e.id,MIN(CASE WHEN a.surface_original=?3 THEN 0 WHEN a.nfc_key=?4 THEN 1 ELSE 2 END) priority \
        FROM memory_aliases a JOIN memory_nodes e ON e.id=a.node_id \
        JOIN memory_chunk_sources s ON s.source_id=a.source_id JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision \
        LEFT JOIN memory_claims mc ON mc.node_id=e.id \
        WHERE (a.surface_original=?3 OR a.nfc_key=?4 OR a.folded_key=?5) AND {ELIGIBLE} GROUP BY e.id"
    );
    let mut query = db.prepare(&sql).map_err(db_error)?;
    let mut priorities = HashMap::new();
    for row in query
        .query_map(params![project, as_of, phrase, nfc, folded], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })
        .map_err(db_error)?
    {
        let (id, priority) = row.map_err(db_error)?;
        priorities
            .entry(id)
            .and_modify(|v: &mut i64| *v = (*v).min(priority))
            .or_insert(priority);
    }
    Ok(rank_aliases(priorities))
}

fn lexical(
    db: &Connection,
    project: Option<&str>,
    as_of: &str,
    cue: &str,
    deadline: i64,
) -> CognitionResult<(Vec<RankedCandidate>, bool)> {
    let query_grams = lexical::folded_grams(cue);
    if query_grams.is_empty() {
        return Ok((Vec::new(), false));
    }
    let count_sql = format!(
        "SELECT COUNT(*) FROM (SELECT DISTINCT a.node_id,a.source_id,a.surface_original \
        FROM memory_aliases a JOIN memory_nodes e ON e.id=a.node_id \
        JOIN memory_chunk_sources s ON s.source_id=a.source_id JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision \
        LEFT JOIN memory_claims mc ON mc.node_id=e.id WHERE {ELIGIBLE})"
    );
    let corpus_size = usize::try_from(
        db.query_row(&count_sql, params![project, as_of], |r| r.get::<_, i64>(0))
            .map_err(db_error)?,
    )
    .unwrap_or_default();
    let grams_json = serde_json::to_string(&query_grams).map_err(json_error)?;
    let matched_sql = format!(
        "SELECT DISTINCT p.node_id,p.source_id,p.surface_original FROM memory_alias_postings p \
        JOIN memory_nodes e ON e.id=p.node_id JOIN memory_chunk_sources s ON s.source_id=p.source_id \
        JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision \
        LEFT JOIN memory_claims mc ON mc.node_id=e.id \
        WHERE p.gram IN (SELECT value FROM json_each(?3)) AND {ELIGIBLE} ORDER BY p.node_id,p.source_id,p.surface_original"
    );
    let mut query = db.prepare(&matched_sql).map_err(db_error)?;
    let mut rows = query
        .query(params![project, as_of, grams_json])
        .map_err(db_error)?;
    let mut documents = Vec::new();
    let mut partial = false;
    while let Some(row) = rows.next().map_err(db_error)? {
        if super::current_millis() >= deadline {
            partial = true;
            break;
        }
        let id = row.get::<_, String>(0).map_err(db_error)?;
        let surface = row.get::<_, String>(2).map_err(db_error)?;
        documents.push((id, lexical::folded_grams(&surface)));
    }
    let mut all_grams = Vec::new();
    let mut seen = HashSet::new();
    for gram in query_grams
        .iter()
        .chain(documents.iter().flat_map(|(_, grams)| grams))
    {
        if seen.insert(gram) {
            all_grams.push(gram.clone());
        }
    }
    let mut df = HashMap::new();
    if super::current_millis() < deadline {
        let df_sql = format!(
            "WITH eligible AS MATERIALIZED (SELECT DISTINCT a.node_id,a.source_id FROM memory_aliases a \
            JOIN memory_nodes e ON e.id=a.node_id JOIN memory_chunk_sources s ON s.source_id=a.source_id \
            JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision \
            LEFT JOIN memory_claims mc ON mc.node_id=e.id WHERE {ELIGIBLE}) \
            SELECT p.gram,COUNT(*) FROM memory_alias_postings p JOIN eligible d ON d.node_id=p.node_id AND d.source_id=p.source_id \
            WHERE p.gram IN (SELECT value FROM json_each(?3)) GROUP BY p.gram"
        );
        for gram in &all_grams {
            df.insert(gram.clone(), 0usize);
        }
        let encoded = serde_json::to_string(&all_grams).map_err(json_error)?;
        let mut statement = db.prepare(&df_sql).map_err(db_error)?;
        for row in statement
            .query_map(params![project, as_of, encoded], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
            })
            .map_err(db_error)?
        {
            let (gram, count) = row.map_err(db_error)?;
            df.insert(gram, usize::try_from(count).unwrap_or_default());
        }
    }
    if query_grams.iter().any(|gram| !df.contains_key(gram)) {
        return Ok((Vec::new(), true));
    }
    Ok((
        rank_lexical(&query_grams, documents, corpus_size, &df),
        partial,
    ))
}

fn vectors(
    db: &Connection,
    project: Option<&str>,
    as_of: &str,
    hits: &[super::VectorHit],
) -> CognitionResult<Vec<RankedCandidate>> {
    let mut ids = Vec::new();
    let mut seen = HashSet::new();
    for hit in hits {
        if seen.insert(hit.owner_id.as_str()) {
            ids.push(hit.owner_id.as_str());
            if ids.len() == 64 {
                break;
            }
        }
    }
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let encoded = serde_json::to_string(&ids).map_err(json_error)?;
    let sql = format!(
        "SELECT DISTINCT m.node_id FROM memory_evidence m JOIN memory_nodes e ON e.id=m.node_id \
        JOIN memory_chunk_sources s ON s.source_id=m.source_id JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision \
        LEFT JOIN memory_claims mc ON mc.node_id=e.id WHERE m.node_id IN (SELECT value FROM json_each(?3)) AND {ELIGIBLE}"
    );
    let mut statement = db.prepare(&sql).map_err(db_error)?;
    let eligible = statement
        .query_map(params![project, as_of, encoded], |r| r.get::<_, String>(0))
        .map_err(db_error)?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(db_error)?;
    Ok(hits
        .iter()
        .filter(|h| eligible.contains(&h.owner_id))
        .take(64)
        .map(|hit| RankedCandidate {
            node_id: hit.owner_id.clone(),
            channel: Channel::Vector,
            rank: hit.rank,
            score: 1.0 / (1.0 + hit.distance.max(0.0)),
        })
        .collect())
}

fn context(
    db: &Connection,
    canonical: &ConversationSourceReader,
    input: &ExtractInput,
    project: Option<&str>,
    as_of: &str,
) -> CognitionResult<Vec<RankedCandidate>> {
    let session = db
        .query_row(
            "SELECT conversation_session_id FROM memory_chunks WHERE memory_chunk_id=?1",
            [&input.episode_ref],
            |r| r.get::<_, Option<String>>(0),
        )
        .map_err(db_error)?;
    let Some(session) = session else {
        return Ok(Vec::new());
    };
    let messages = canonical
        .read_recent_public_message_ids(&session)
        .map_err(crate::cognition::CognitionError::from)?;
    if messages.is_empty() {
        return Ok(Vec::new());
    }
    let encoded = serde_json::to_string(&messages).map_err(json_error)?;
    let sql = format!(
        "SELECT DISTINCT m.node_id,s.observed_at FROM memory_evidence m \
        JOIN memory_chunk_sources s ON s.source_id=m.source_id JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision \
        JOIN memory_nodes e ON e.id=m.node_id LEFT JOIN memory_claims mc ON mc.node_id=e.id \
        WHERE s.conversation_message_id IN (SELECT value FROM json_each(?3)) AND {ELIGIBLE} \
        ORDER BY s.observed_at DESC,m.node_id"
    );
    let mut statement = db.prepare(&sql).map_err(db_error)?;
    let mut ids = Vec::new();
    let mut seen = HashSet::new();
    for row in statement
        .query_map(params![project, as_of, encoded], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(db_error)?
    {
        let (id, _observed_at) = row.map_err(db_error)?;
        if seen.insert(id.clone()) && ids.len() < 4 {
            ids.push(id);
        }
    }
    Ok(ids
        .into_iter()
        .enumerate()
        .map(|(i, node_id)| RankedCandidate {
            node_id,
            channel: Channel::Context,
            rank: i + 1,
            score: 1.0,
        })
        .collect())
}
