//! Source-index raw candidate selection before the corpus inventory audit.

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, params_from_iter, types::Value as SqlValue};
use serde::Serialize;

use super::{db_error, scope};
use crate::cognition::CognitionCode;
use crate::cognition::{CognitionResult, lexical, recall::RecallRequest};

#[derive(Clone, Debug)]
pub(in crate::cognition) struct RawSourceCandidate {
    pub source_id: String,
    pub episode_id: String,
    pub score: f64,
    pub exact_match: bool,
}

#[derive(Debug)]
pub(in crate::cognition) struct RawSourceSelection {
    pub sources: Vec<RawSourceCandidate>,
    pub partial: bool,
}

#[derive(Serialize)]
struct WeightedTerm<'a> {
    term: &'a str,
    weight: f64,
}

/// Most query terms a raw selection weighs.
const MAX_TERMS: usize = 256;

/// BM25-style source candidates for the cue and seed phrases, exact cue
/// matches first. Partial when terms were dropped or the deadline passed.
pub(super) fn select(
    db: &Connection,
    input: &RecallRequest,
    deadline_at: i64,
    mut now_millis: impl FnMut() -> i64,
) -> CognitionResult<RawSourceSelection> {
    let all_terms = query_terms(input);
    let terms = all_terms.get(..MAX_TERMS).unwrap_or(&all_terms);
    if terms.is_empty() || now_millis() >= deadline_at {
        return Ok(RawSourceSelection {
            sources: Vec::new(),
            partial: now_millis() >= deadline_at,
        });
    }
    let predicate = scope::source(input, "s", "c");
    let stats_sql = format!(
        r"
        SELECT COUNT(*) count, AVG(length(raw.text)) average_length
        FROM memory_source_text raw
        JOIN memory_source_leaves s ON s.source_id=raw.source_id
        JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
        WHERE {}
    ",
        predicate.sql
    );
    let (population, average_length): (i64, Option<f64>) = db
        .query_row(&stats_sql, params_from_iter(&predicate.args), |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .map_err(db_error)?;
    let weights = term_weights(db, &predicate, terms, population)?;
    let sources = ranked_sources(
        db,
        predicate,
        &weights,
        (
            average_length,
            butler_core::public_text::trim_js_whitespace(&input.cue),
        ),
    )?;
    Ok(RawSourceSelection {
        sources,
        partial: all_terms.len() > MAX_TERMS || now_millis() >= deadline_at,
    })
}

/// Distinct case-folded grams of the cue and seed phrases, in order; a
/// phrase too short for grams is one term.
fn query_terms(input: &RecallRequest) -> Vec<String> {
    let mut all_terms = Vec::new();
    let mut seen = HashSet::new();
    for phrase in
        std::iter::once(input.cue.as_str()).chain(input.seed_phrases.iter().map(String::as_str))
    {
        let folded = lexical::case_fold(butler_core::public_text::trim_js_whitespace(phrase));
        let grams = lexical::folded_grams(&folded);
        let terms = if grams.is_empty() {
            vec![folded]
        } else {
            grams
        };
        for term in terms {
            if !butler_core::public_text::trim_js_whitespace(&term).is_empty()
                && seen.insert(term.clone())
            {
                all_terms.push(term);
            }
        }
    }
    all_terms
}

/// Inverse document frequency of each term within the scoped sources.
fn term_weights<'a>(
    db: &Connection,
    predicate: &scope::Predicate,
    terms: &'a [String],
    population: i64,
) -> CognitionResult<Vec<WeightedTerm<'a>>> {
    let encoded_terms = serde_json::to_string(terms).map_err(json_error)?;
    let frequency_sql = format!(
        r"
        SELECT p.term, COUNT(*) count
        FROM memory_source_terms p
        JOIN memory_source_text raw ON raw.id=p.source_key
        JOIN memory_source_leaves s ON s.source_id=raw.source_id
        JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
        WHERE p.term IN (SELECT value FROM json_each(?)) AND {}
        GROUP BY p.term
    ",
        predicate.sql
    );
    let mut frequency_args = vec![SqlValue::Text(encoded_terms)];
    frequency_args.extend(predicate.args.iter().cloned());
    let mut statement = db.prepare(&frequency_sql).map_err(db_error)?;
    let frequencies = statement
        .query_map(params_from_iter(&frequency_args), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(db_error)?
        .collect::<Result<HashMap<_, _>, _>>()
        .map_err(db_error)?;
    Ok(terms
        .iter()
        .map(|term| {
            let df = *frequencies.get(term).unwrap_or(&0) as f64;
            let weight = (1.0 + (population as f64 - df + 0.5) / (df + 0.5)).ln();
            WeightedTerm { term, weight }
        })
        .collect())
}

/// The 64 best sources matching enough weighted terms.
fn ranked_sources(
    db: &Connection,
    predicate: scope::Predicate,
    weights: &[WeightedTerm<'_>],
    (average_length, cue): (Option<f64>, &str),
) -> CognitionResult<Vec<RawSourceCandidate>> {
    let query_weight = weights.iter().map(|item| item.weight).sum::<f64>();
    let encoded_weights = serde_json::to_string(weights).map_err(json_error)?;
    let candidate_sql = format!(
        r"
        WITH query AS (
            SELECT json_extract(value,'$.term') term,
                   json_extract(value,'$.weight') weight
            FROM json_each(?)
        )
        SELECT s.source_id, s.episode_id,
               SUM(q.weight)/? * 2.2/(1 + 1.2 * (0.25 + 0.75 * length(raw.text)/?)) score,
               CASE WHEN instr(raw.text,?)>0 THEN 1 ELSE 0 END exact_match
        FROM query q
        JOIN memory_source_terms p ON p.term=q.term
        JOIN memory_source_text raw ON raw.id=p.source_key
        JOIN memory_source_leaves s ON s.source_id=raw.source_id
        JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
        WHERE {}
        GROUP BY s.source_id
        HAVING COUNT(DISTINCT p.term)>=?
        ORDER BY exact_match DESC, score DESC, s.observed_at DESC, s.source_id
        LIMIT ?
    ",
        predicate.sql
    );
    let mut args = vec![
        SqlValue::Text(encoded_weights),
        SqlValue::Real(query_weight),
        SqlValue::Real(average_length.unwrap_or(1.0).max(1.0)),
        SqlValue::Text(cue.to_owned()),
    ];
    args.extend(predicate.args);
    args.push(SqlValue::Integer(if weights.len() == 1 { 1 } else { 2 }));
    args.push(SqlValue::Integer(64));
    let mut statement = db.prepare(&candidate_sql).map_err(db_error)?;
    statement
        .query_map(params_from_iter(&args), |row| {
            Ok(RawSourceCandidate {
                source_id: row.get(0)?,
                episode_id: row.get(1)?,
                score: row.get(2)?,
                exact_match: row.get::<_, i64>(3)? != 0,
            })
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)
}

fn json_error(error: serde_json::Error) -> crate::cognition::CognitionError {
    crate::cognition::CognitionError::new(CognitionCode::MemoryGraphUnavailable, error.to_string())
        .with_source(error)
}
