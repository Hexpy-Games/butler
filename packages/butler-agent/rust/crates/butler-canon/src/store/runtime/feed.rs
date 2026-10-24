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
pub fn pending(db: &Connection) -> Result<bool> {
    Ok(
        !rows(db, Query::Plans.sql(), [cursor(db, "link_reconcile")?])?.is_empty()
            || !rows(db, Query::Feed.sql(), [cursor(db, "progress_feed")?])?.is_empty(),
    )
}

/// Keyset batches: never rewrites a cursor or emits anything when idle.
pub fn catch_up(tx: &Transaction<'_>, ctx: &Context) -> Result<()> {
    let plans = rows(tx, Query::Plans.sql(), [cursor(tx, "link_reconcile")?])?;
    for plan in &plans {
        let refs: Vec<String> = serde_json::from_str(text(plan, "governing_refs_json")?)?;
        link(
            tx,
            ctx,
            text(plan, "session_id")?,
            text(plan, "work_id")?,
            &refs,
        )?;
    }
    if let Some(last) = plans.last() {
        advance(
            tx,
            "link_reconcile",
            last["rowid"].as_i64().ok_or(Error::Invalid("rowid"))?,
        )?;
    }
    let changes = rows(tx, Query::Feed.sql(), [cursor(tx, "progress_feed")?])?;
    let mut epics = BTreeSet::new();
    for change in &changes {
        for epic in rows(tx, Query::SessionEpics.sql(), [text(change, "session_id")?])? {
            epics.insert(text(&epic, "epic_id")?.to_owned());
        }
    }
    for epic in epics {
        for work in rows(tx, Query::Works.sql(), [&epic])? {
            if progress::reported(tx, text(&work, "work_id")?)? {
                advance_label(tx, ctx, &epic, "in_review")?;
            }
        }
        progress_event(tx, ctx, &epic)?;
    }
    if let Some(last) = changes.last() {
        advance(
            tx,
            "progress_feed",
            last["seq"].as_i64().ok_or(Error::Invalid("seq"))?,
        )?;
    }
    Ok(())
}
