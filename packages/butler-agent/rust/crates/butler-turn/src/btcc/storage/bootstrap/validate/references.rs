//! Logical reference findings are diagnostics, never a physical-corruption verdict.
mod rules;
use super::{StorageError, StorageResult};
use rusqlite::Connection;

struct Rule {
    name: &'static str,
    from_table: &'static str,
    from_column: &'static str,
    to_table: &'static str,
    to_column: &'static str,
    filter: Option<&'static str>,
    ownership: bool,
}

#[derive(Debug)]
pub(in crate::btcc::storage) struct ReferenceFailure {
    pub rule: &'static str,
    pub count: u64,
}

pub(super) fn validate(db: &Connection) -> StorageResult<Vec<ReferenceFailure>> {
    let mut failures = Vec::new();
    for rule in rules::RULES {
        let started = std::time::Instant::now();
        super::activated::trace(&format!("reference_{}_begin", rule.name), started);
        let predicate = rule
            .filter
            .map_or(String::new(), |filter| format!("AND {filter}"));
        let ownership = if rule.ownership {
            "AND target.work_id = source.work_id"
        } else {
            ""
        };
        let sql = format!(
            "SELECT COUNT(*) FROM {from_table} AS source LEFT JOIN {to_table} AS target ON target.{to_column} = source.{from_column} {ownership} WHERE source.{from_column} IS NOT NULL {predicate} AND target.{to_column} IS NULL",
            from_table = rule.from_table,
            to_table = rule.to_table,
            from_column = rule.from_column,
            to_column = rule.to_column,
        );
        let count = db
            .query_row(&sql, [], |row| row.get(0))
            .map_err(StorageError::sqlite)?;
        super::activated::trace(&format!("reference_{}_end", rule.name), started);
        if count != 0 {
            failures.push(ReferenceFailure {
                rule: rule.name,
                count,
            });
        }
    }
    let count = db.query_row("SELECT COUNT(*) FROM btcc_stop_requests AS stop LEFT JOIN btcc_turns AS turn ON turn.turn_id = stop.turn_id WHERE turn.turn_id IS NULL AND stop.status != 'cancelled_before_admission'", [], |row| row.get(0)).map_err(StorageError::sqlite)?;
    if count != 0 {
        failures.push(ReferenceFailure {
            rule: "stop_turn",
            count,
        });
    }
    Ok(failures)
}
