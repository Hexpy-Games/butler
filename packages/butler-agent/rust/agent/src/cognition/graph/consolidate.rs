//! Source-compatible v2 edge support consolidation.

use std::collections::HashMap;

use rusqlite::{Connection, Transaction};
use serde_json::{Map, Number, Value};

use crate::{
    cognition::{CognitionError, CognitionResult},
    js_date,
};

#[cfg(test)]
#[path = "consolidate/tests.rs"]
mod tests;

const READ_ROWS: &str = "SELECT e.edge_id,e.qualifiers,
    COUNT(DISTINCT CASE WHEN c.current_revision=s.revision AND c.status='active' THEN s.episode_id END),
    MAX(CASE WHEN c.current_revision=s.revision AND c.status='active' THEN s.observed_at END)
    FROM edges e
    LEFT JOIN edge_evidence ee ON ee.edge_id=e.edge_id
    LEFT JOIN memory_chunk_sources s ON s.source_id=ee.chunk_source_id
    LEFT JOIN memory_chunks c ON c.memory_chunk_id=s.episode_id
    GROUP BY e.edge_id,e.qualifiers ORDER BY e.edge_id";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(in crate::cognition) struct GraphConsolidateMetrics {
    pub candidates_considered: usize,
    pub merges_applied: usize,
    pub edges_boosted: usize,
    pub conflicts_archived: usize,
    pub activations_written: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SourceRow {
    edge_id: String,
    qualifiers: String,
    support_count: i64,
    latest_observed_at: Option<String>,
}

struct PreparedRow {
    source: SourceRow,
    next_qualifiers: String,
}

pub(super) fn run(
    connection: &mut Connection,
    now_ms: i64,
    decay_d: f64,
) -> CognitionResult<GraphConsolidateMetrics> {
    if !has_v2_edges(connection)? {
        return Err(CognitionError::new(
            "memory_consolidation_v2_required",
            "memory_consolidation_v2_required",
        ));
    }

    let source_rows = read_rows(connection)?;
    let prepared = source_rows
        .iter()
        .map(|source| prepare_row(source, now_ms, decay_d))
        .collect::<CognitionResult<Vec<_>>>()?;

    let transaction = connection.transaction().map_err(db_error)?;
    verify_and_write(&transaction, &prepared)?;
    transaction.commit().map_err(db_error)?;

    Ok(GraphConsolidateMetrics {
        candidates_considered: source_rows.len(),
        merges_applied: 0,
        edges_boosted: prepared
            .iter()
            .filter(|row| row.source.qualifiers != row.next_qualifiers)
            .count(),
        conflicts_archived: 0,
        activations_written: 0,
    })
}

fn has_v2_edges(connection: &Connection) -> CognitionResult<bool> {
    let mut statement = connection
        .prepare("PRAGMA table_info(edges)")
        .map_err(db_error)?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(db_error)?;
    for column in columns {
        if column.map_err(db_error)? == "edge_id" {
            return Ok(true);
        }
    }
    Ok(false)
}

fn read_rows(connection: &Connection) -> CognitionResult<Vec<SourceRow>> {
    let mut statement = connection.prepare(READ_ROWS).map_err(db_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok(SourceRow {
                edge_id: row.get(0)?,
                qualifiers: row.get(1)?,
                support_count: row.get(2)?,
                latest_observed_at: row.get(3)?,
            })
        })
        .map_err(db_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
}

fn prepare_row(row: &SourceRow, now_ms: i64, decay_d: f64) -> CognitionResult<PreparedRow> {
    let qualifiers_json = if row.qualifiers.is_empty() {
        "{}"
    } else {
        &row.qualifiers
    };
    let mut qualifiers = serde_json::from_str::<Map<String, Value>>(qualifiers_json)
        .map_err(|_| error("memory_consolidation_invalid_qualifiers"))?;
    let age_days = row
        .latest_observed_at
        .as_deref()
        .and_then(|observed| js_date::parse_date_millis(observed, &Some))
        .map(|observed| ((now_ms as f64 - observed as f64).max(0.0)) / 86_400_000.0);
    let decayed_support = age_days
        .map(|age| row.support_count as f64 * (1.0 + age).powf(-decay_d))
        .unwrap_or(0.0);

    qualifiers.insert(
        "active_support_episodes".to_owned(),
        Value::from(row.support_count),
    );
    qualifiers.insert("decayed_support".to_owned(), json_number(decayed_support));
    let next_qualifiers = serde_json::to_string(&qualifiers)
        .map_err(|_| error("memory_consolidation_invalid_qualifiers"))?;
    Ok(PreparedRow {
        source: row.clone(),
        next_qualifiers,
    })
}

fn json_number(value: f64) -> Value {
    if value.is_finite()
        && value.fract() == 0.0
        && value >= i64::MIN as f64
        && value < i64::MAX as f64
    {
        Value::from(crate::json::saturating_i64(value))
    } else {
        Number::from_f64(value)
            .map(Value::Number)
            .unwrap_or(Value::Null)
    }
}

fn verify_and_write(
    transaction: &Transaction<'_>,
    prepared: &[PreparedRow],
) -> CognitionResult<()> {
    let current = read_rows(transaction)?
        .into_iter()
        .map(|row| (row.edge_id.clone(), row))
        .collect::<HashMap<_, _>>();
    for row in prepared {
        let Some(now) = current.get(&row.source.edge_id) else {
            return Err(source_changed());
        };
        if now.qualifiers != row.source.qualifiers
            || now.support_count != row.source.support_count
            || now.latest_observed_at != row.source.latest_observed_at
        {
            return Err(source_changed());
        }
        if row.next_qualifiers != row.source.qualifiers {
            transaction
                .execute(
                    "UPDATE edges SET qualifiers=?1 WHERE edge_id=?2",
                    (&row.next_qualifiers, &row.source.edge_id),
                )
                .map_err(db_error)?;
        }
    }
    Ok(())
}

fn source_changed() -> CognitionError {
    error("memory_source_changed")
}

fn db_error(_: rusqlite::Error) -> CognitionError {
    error("memory_graph_unavailable")
}

fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
