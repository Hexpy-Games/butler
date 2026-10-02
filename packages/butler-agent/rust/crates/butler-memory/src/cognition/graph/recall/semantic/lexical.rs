//! Source-corpus lexical frequency and posting selection.
//!
//! Aliases whose grams overlap the cue are ranked by gram frequency over the
//! aliases of eligible nodes and sources.

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, params_from_iter, types::Value as SqlValue};

use crate::cognition::{
    CognitionResult, lexical,
    recall::{RankedCandidate, RecallRequest, rank_lexical},
};

use super::super::{db_error, scope};
use super::json_error;

const ALIAS_JOIN: &str = "JOIN memory_nodes e ON e.id=a.node_id
        JOIN memory_chunk_sources s ON s.source_id=a.source_id
        JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision";

/// Aliases as `(node id, folded grams)`.
type Documents = Vec<(String, Vec<String>)>;

/// The eligible alias corpus: claim and source scope predicates.
struct Corpus {
    claim_sql: String,
    source_sql: String,
    args: Vec<SqlValue>,
}

/// Ranked alias candidates for the cue, and whether the deadline cut the
/// postings or frequencies short.
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
    let mut args = claim.args.clone();
    args.extend(source.args.iter().cloned());
    let corpus = Corpus {
        claim_sql: claim.sql,
        source_sql: source.sql,
        args,
    };
    let corpus_size = corpus.size(db)?;
    let (documents, partial) = corpus.postings(db, &query_grams, deadline_at, now_millis)?;
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
    let df = if now_millis() < deadline_at {
        corpus.document_frequencies(db, &all_grams)?
    } else {
        HashMap::new()
    };
    if query_grams.iter().any(|gram| !df.contains_key(gram)) {
        return Ok((Vec::new(), true));
    }
    Ok((
        rank_lexical(&query_grams, documents, corpus_size, &df),
        partial,
    ))
}

impl Corpus {
    /// Distinct `(node, source, surface)` aliases in scope.
    fn size(&self, db: &Connection) -> CognitionResult<usize> {
        let sql = format!(
            "SELECT COUNT(*) FROM (SELECT DISTINCT a.node_id,a.source_id,a.surface_original
             FROM memory_aliases a {ALIAS_JOIN} WHERE {} AND {})",
            self.claim_sql, self.source_sql
        );
        let count = db
            .query_row(&sql, params_from_iter(self.args.iter().cloned()), |row| {
                row.get::<_, i64>(0)
            })
            .map_err(db_error)?;
        Ok(usize::try_from(count).unwrap_or_default())
    }

    /// Aliases posted under any query gram, with their own grams; stops at
    /// the deadline.
    fn postings(
        &self,
        db: &Connection,
        query_grams: &[String],
        deadline_at: i64,
        now_millis: &mut impl FnMut() -> i64,
    ) -> CognitionResult<(Documents, bool)> {
        let sql = format!(
            "SELECT DISTINCT p.node_id,p.source_id,p.surface_original
             FROM memory_alias_postings p
             JOIN memory_nodes e ON e.id=p.node_id
             JOIN memory_chunk_sources s ON s.source_id=p.source_id
             JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
             WHERE p.gram IN (SELECT value FROM json_each(?)) AND {} AND {}
             ORDER BY p.node_id,p.source_id,p.surface_original",
            self.claim_sql, self.source_sql
        );
        let mut args = vec![SqlValue::Text(
            serde_json::to_string(query_grams).map_err(json_error)?,
        )];
        args.extend(self.args.iter().cloned());
        let sql = crate::cognition::graph::alias_postings::query(db, &sql)?;
        let mut statement = db.prepare(&sql).map_err(db_error)?;
        let mut rows = statement.query(params_from_iter(args)).map_err(db_error)?;
        let mut documents = Vec::new();
        while let Some(row) = rows.next().map_err(db_error)? {
            if now_millis() >= deadline_at {
                return Ok((documents, true));
            }
            let node_id: String = row.get(0).map_err(db_error)?;
            let surface: String = row.get(2).map_err(db_error)?;
            documents.push((node_id, lexical::folded_grams(&surface)));
        }
        Ok((documents, false))
    }

    /// How many eligible aliases carry each gram (zero when none).
    fn document_frequencies(
        &self,
        db: &Connection,
        grams: &[String],
    ) -> CognitionResult<HashMap<String, usize>> {
        let sql = format!(
            "WITH eligible AS MATERIALIZED (
               SELECT DISTINCT a.node_id,a.source_id FROM memory_aliases a {ALIAS_JOIN}
               WHERE {} AND {}
             )
             SELECT p.gram,COUNT(*) FROM memory_alias_postings p
             CROSS JOIN eligible d ON d.node_id=p.node_id AND d.source_id=p.source_id
             WHERE p.gram IN (SELECT value FROM json_each(?)) GROUP BY p.gram",
            self.claim_sql, self.source_sql
        );
        let mut df = grams
            .iter()
            .map(|gram| (gram.clone(), 0usize))
            .collect::<HashMap<_, _>>();
        let mut args = self.args.clone();
        args.push(SqlValue::Text(
            serde_json::to_string(grams).map_err(json_error)?,
        ));
        let sql = crate::cognition::graph::alias_postings::query(db, &sql)?;
        let mut statement = db.prepare(&sql).map_err(db_error)?;
        for row in statement
            .query_map(params_from_iter(args), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(db_error)?
        {
            let (gram, count) = row.map_err(db_error)?;
            df.insert(gram, usize::try_from(count).unwrap_or_default());
        }
        Ok(df)
    }
}
