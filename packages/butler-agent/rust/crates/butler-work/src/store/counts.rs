use super::*;
use rusqlite::params;
/// Branch-1/imported rows may predate counters. Initialize one indexed scope
/// once, then keep counters by delta in the domain transaction.
pub(super) fn ensure_work_counts(tx: &Transaction<'_>, scope: (&str, &str)) -> Result<()> {
    if tx.counts_pending(scope) {
        return Ok(());
    }
    match one(tx, sql::COUNT_ROW, params![scope.0, scope.1, "works"]) {
        Ok(_) => return Ok(()),
        Err(Error::NotFound) => {}
        Err(e) => return Err(e),
    }
    let states = rows(tx, sql::SCOPE_COUNTS, params![scope.0, scope.1])?;
    let mut total = 0;
    for state in states {
        let n = state["count"].as_i64().ok_or(Error::Invalid("count"))?;
        count(
            tx,
            scope,
            &format!("run_state:{}", text(&state, "run_state")?),
            n,
        )?;
        total += n;
    }
    count(tx, scope, "works", total)
}
