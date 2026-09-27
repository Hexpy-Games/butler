//! Exact/NFC/folded aliases over currently eligible sources.

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, params_from_iter, types::Value};
use unicode_normalization::UnicodeNormalization;

use crate::cognition::{
    CognitionResult, lexical,
    recall::{RankedCandidate, RecallRequest, rank_aliases},
};

use super::super::{db_error, scope};

pub(super) fn select(
    db: &Connection,
    input: &RecallRequest,
) -> CognitionResult<Vec<RankedCandidate>> {
    let mut seen = HashSet::new();
    let mut priorities = HashMap::<String, i64>::new();
    let source = scope::source(input, "s", "c");
    let claim = scope::claim(input, "e", "id");
    let sql = format!(
        "SELECT e.id, MIN(CASE WHEN a.surface_original=? THEN 0 WHEN a.nfc_key=? THEN 1 ELSE 2 END) AS priority
         FROM memory_aliases a
         JOIN memory_nodes e ON e.id=a.node_id
         JOIN memory_chunk_sources s ON s.source_id=a.source_id
         JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id AND c.current_revision=s.revision
         WHERE (a.surface_original=? OR a.nfc_key=? OR a.folded_key=?)
           AND {} AND {}
         GROUP BY e.id",
        claim.sql, source.sql
    );
    let mut statement = db.prepare(&sql).map_err(db_error)?;
    for original in std::iter::once(&input.cue).chain(input.seed_phrases.iter()) {
        let phrase = crate::public_text::trim_js_whitespace(original);
        let nfc = phrase.nfc().collect::<String>();
        if phrase.is_empty() || !seen.insert(nfc.clone()) {
            continue;
        }
        let mut args = vec![
            Value::Text(phrase.to_owned()),
            Value::Text(nfc.clone()),
            Value::Text(phrase.to_owned()),
            Value::Text(nfc),
            Value::Text(lexical::case_fold(phrase)),
        ];
        args.extend(claim.args.iter().cloned());
        args.extend(source.args.iter().cloned());
        let rows = statement
            .query_map(params_from_iter(args), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(db_error)?;
        for row in rows {
            let (node_id, priority) = row.map_err(db_error)?;
            priorities
                .entry(node_id)
                .and_modify(|old| *old = (*old).min(priority))
                .or_insert(priority);
        }
    }
    Ok(rank_aliases(priorities))
}
