use super::*;
use std::collections::BTreeSet;

fn cursor(db: &Connection, name: &str) -> Result<i64> {
    Ok(db
        .query_row(Query::Cursor.sql(), [name], |r| r.get(0))
        .optional()?
        .unwrap_or(0))
}
fn advance(tx: &Transaction<'_>, name: &str, value: i64) -> Result<()> {
    tx.execute(Query::AdvanceCursor.sql(), params![name, value])?;
    Ok(())
}
fn changes(db: &Connection, after: i64) -> Result<Vec<Value>> {
    rows(
        db,
        Query::Feed.sql(),
        [after.max(cursor(db, "progress_feed")?)],
    )
}
fn epics(db: &Connection, changes: &[Value]) -> Result<BTreeSet<String>> {
    let mut epics = BTreeSet::new();
    for change in changes {
        for epic in rows(db, Query::SessionEpics.sql(), [text(change, "session_id")?])? {
            epics.insert(text(&epic, "epic_id")?.to_owned());
        }
    }
    Ok(epics)
}
pub fn pending(db: &Connection, after: i64) -> Result<bool> {
    Ok(
        !rows(db, Query::Plans.sql(), [cursor(db, "link_reconcile")?])?.is_empty()
            || !changes(db, after)?.is_empty(),
    )
}
pub fn changed_works(db: &Connection, after: i64) -> Result<Vec<Value>> {
    let mut works = Vec::new();
    for epic in epics(db, &changes(db, after)?)? {
        works.extend(rows(db, Query::Works.sql(), [&epic])?);
    }
    for plan in rows(db, Query::Plans.sql(), [cursor(db, "link_reconcile")?])? {
        if let Some(raw) = plan["result_json"].as_str()
            && let Ok(result) = serde_json::from_str::<Value>(raw)
        {
            let result = result.get("output").unwrap_or(&result);
            if let Some(id) = result["work"]["work_id"].as_str() {
                works.extend(rows(db, Query::Work.sql(), [id])?);
            }
        }
    }
    Ok(works)
}

// Savepoints prevent a quarantined row from leaving a partial label or event.
fn quarantine(
    tx: &Transaction<'_>,
    operation: impl FnOnce() -> Result<()>,
) -> Result<Option<String>> {
    tx.execute_batch("SAVEPOINT canon_reconcile_row")?;
    let error = operation().err();
    if error.is_some() {
        tx.execute_batch("ROLLBACK TO canon_reconcile_row")?;
    }
    tx.execute_batch("RELEASE canon_reconcile_row")?;
    Ok(error.map(|error| error.to_string()))
}
fn reconcile_link(tx: &Transaction<'_>, ctx: &Context, plan: &Value) -> Result<()> {
    let args: Value = serde_json::from_str(text(plan, "arguments_json")?)?;
    let result: Value = serde_json::from_str(text(plan, "result_json")?)?;
    let result = result.get("output").unwrap_or(&result);
    if result["ok"] != true {
        return Ok(());
    }
    let refs: Vec<String> =
        serde_json::from_value(args.get("governing_refs").cloned().unwrap_or(json!([])))?;
    link(
        tx,
        ctx,
        text(plan, "session_id")?,
        text(&result["work"], "work_id")?,
        &refs,
    )
}
pub struct Reconciled {
    pub after: i64,
    pub diagnostics: Vec<(Value, String)>,
}

/// Keyset batches; unrelated changes only advance the caller's memory cursor.
pub fn catch_up(
    tx: &Transaction<'_>,
    ctx: &Context,
    views: &ProjectViews,
    after: i64,
) -> Result<Reconciled> {
    let mut diagnostics = Vec::new();
    let plans = rows(tx, Query::Plans.sql(), [cursor(tx, "link_reconcile")?])?;
    for plan in &plans {
        if let Some(error) = quarantine(tx, || reconcile_link(tx, ctx, plan))? {
            diagnostics.push((plan["rowid"].clone(), error));
        }
    }
    if let Some(last) = plans.last() {
        advance(
            tx,
            "link_reconcile",
            last["rowid"].as_i64().ok_or(Error::Invalid("rowid"))?,
        )?;
    }
    let changes = changes(tx, after)?;
    let epics = epics(tx, &changes)?;
    for epic in &epics {
        if let Some(error) = quarantine(tx, || {
            for work in rows(tx, Query::Works.sql(), [epic])? {
                let id = text(&work, "work_id")?;
                if work["reported_applied"] == 0 && progress::reported(tx, &work, views)? {
                    advance_label(tx, ctx, epic, "in_review")?;
                    tx.execute(Query::Applied.sql(), [id])?;
                }
            }
            progress_event(tx, ctx, epic)
        })? {
            diagnostics.push((json!(epic), error));
        }
    }
    let next = changes
        .last()
        .and_then(|c| c["seq"].as_i64())
        .unwrap_or(after);
    if !epics.is_empty() {
        advance(tx, "progress_feed", next)?;
    }
    Ok(Reconciled {
        after: next,
        diagnostics,
    })
}
