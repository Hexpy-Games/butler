//! Source-corpus lexical frequency and posting selection.

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, params_from_iter, types::Value};

use crate::cognition::{
    CognitionResult, lexical,
    recall::{RankedCandidate, RecallRequest, rank_lexical},
};

use super::super::{db_error, scope};
use super::json_error;

pub(super) fn select(
    db: &Connection,
    input: &RecallRequest,
    deadline_at: i64,
    now_millis: &mut impl FnMut() -> i64,
) -> CognitionResult<(Vec<RankedCandidate>, bool)> {
    let query_grams = lexical::folded_grams(&input.cue);
    if query_grams.is_empty() {
        return Ok((Vec::new(), false));
    }
    let claim = scope::claim(input, "e", "id");
    let source = scope::source(input, "s", "c");
    let join = "JOIN memory_nodes e ON e.id=a.node_id
        JOIN memory_chunk_sources s ON s.source_id=a.source_id
        JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision";
    let corpus_sql = format!(
        "SELECT COUNT(*) FROM (SELECT DISTINCT a.node_id,a.source_id,a.surface_original
         FROM memory_aliases a {join} WHERE {} AND {})",
        claim.sql, source.sql
    );
    let mut scope_args = claim.args.clone();
    scope_args.extend(source.args.iter().cloned());
    let corpus_size = db
        .query_row(
            &corpus_sql,
            params_from_iter(scope_args.iter().cloned()),
            |row| row.get::<_, i64>(0),
        )
        .map_err(db_error)? as usize;

    let posting_sql = format!(
        "SELECT DISTINCT p.node_id,p.source_id,p.surface_original
         FROM memory_alias_postings p
         JOIN memory_nodes e ON e.id=p.node_id
         JOIN memory_chunk_sources s ON s.source_id=p.source_id
         JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
         WHERE p.gram IN (SELECT value FROM json_each(?)) AND {} AND {}
         ORDER BY p.node_id,p.source_id,p.surface_original",
        claim.sql, source.sql
    );
    let mut posting_args = vec![Value::Text(
        serde_json::to_string(&query_grams).map_err(json_error)?,
    )];
    posting_args.extend(scope_args.iter().cloned());
    let mut statement = db.prepare(&posting_sql).map_err(db_error)?;
    let mut rows = statement
        .query(params_from_iter(posting_args))
        .map_err(db_error)?;
    let mut documents = Vec::new();
    let mut partial = false;
    while let Some(row) = rows.next().map_err(db_error)? {
        if now_millis() >= deadline_at {
            partial = true;
            break;
        }
        let node_id: String = row.get(0).map_err(db_error)?;
        let surface: String = row.get(2).map_err(db_error)?;
        documents.push((node_id, lexical::folded_grams(&surface)));
    }
    drop(rows);
    drop(statement);

    let mut all_grams = Vec::new();
    let mut seen = HashSet::new();
    for gram in query_grams
        .iter()
        .chain(documents.iter().flat_map(|(_, grams)| grams))
    {
        if seen.insert(gram.as_str()) {
            all_grams.push(gram.clone());
        }
    }
    let mut df = HashMap::new();
    if now_millis() < deadline_at {
        let df_sql = format!(
            "WITH eligible AS MATERIALIZED (
               SELECT DISTINCT a.node_id,a.source_id FROM memory_aliases a {join}
               WHERE {} AND {}
             )
             SELECT p.gram,COUNT(*) FROM memory_alias_postings p
             CROSS JOIN eligible d ON d.node_id=p.node_id AND d.source_id=p.source_id
             WHERE p.gram IN (SELECT value FROM json_each(?)) GROUP BY p.gram",
            claim.sql, source.sql
        );
        for gram in &all_grams {
            df.insert(gram.clone(), 0usize);
        }
        let mut df_args = scope_args;
        df_args.push(Value::Text(
            serde_json::to_string(&all_grams).map_err(json_error)?,
        ));
        let mut statement = db.prepare(&df_sql).map_err(db_error)?;
        for row in statement
            .query_map(params_from_iter(df_args), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(db_error)?
        {
            let (gram, count) = row.map_err(db_error)?;
            df.insert(gram, count as usize);
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
