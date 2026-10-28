//! Session-local epic chains. Caller owns the canon write transaction.
mod edits;
pub mod engine;
mod operations;
pub mod sql;
mod view;
use super::*;
use crate::work_chain::{Chain, Step};
use crate::work_types::EpicId;
pub use edits::edit;
pub use operations::{bound_sessions, decide_hold, owner, request, session_deleted, take_here};
use rusqlite::params;
use std::collections::{BTreeMap, BTreeSet};
pub use view::view;

fn revision(db: &Connection, session: &str) -> Result<i64> {
    Ok(db
        .query_row(sql::REVISION, [session], |r| r.get(0))
        .optional()?
        .unwrap_or(0))
}
fn changed(tx: &Transaction<'_>, ctx: &Context, session: &str) -> Result<i64> {
    tx.execute(sql::ADVANCE_REVISION, [session])?;
    let rev = revision(tx, session)?;
    tx.execute(
        super::sql::OUTBOX,
        params![
            "canon.queue_changed",
            json!({"session_id":session,"graph_revision":rev}).to_string(),
            ctx.now
        ],
    )?;
    Ok(rev)
}
fn items(db: &Connection, session: &str) -> Result<Vec<Value>> {
    rows(db, sql::ITEMS, [session])
}
fn chains(items: &[Value]) -> Result<BTreeMap<String, Chain>> {
    let mut result = BTreeMap::<String, Chain>::new();
    for item in items {
        let chain = result
            .entry(text(item, "chain_id")?.to_owned())
            .or_insert(Chain { steps: Vec::new() });
        let index = index(item, "step_index")?;
        if chain.steps.last().is_none_or(|s| s.index != index) {
            chain.steps.push(Step {
                index,
                tasks: Vec::new(),
            });
        }
        chain
            .steps
            .last_mut()
            .ok_or(Error::Invalid("step"))?
            .tasks
            .push(EpicId(text(item, "epic_id")?.to_owned()));
    }
    for chain in result.values() {
        chain.validate()?;
    }
    Ok(result)
}
fn save(tx: &Transaction<'_>, session: &str, id: &str, chain: &Chain) -> Result<()> {
    for step in &chain.steps {
        for (position, epic) in step.tasks.iter().enumerate() {
            tx.execute(
                sql::PLACE,
                params![
                    session,
                    epic.as_str(),
                    id,
                    ordinal(step.index)?,
                    ordinal(position)?
                ],
            )?;
        }
    }
    Ok(())
}
fn insert(
    tx: &Transaction<'_>,
    ctx: &Context,
    session: &str,
    epic: &str,
    chain: &str,
    index: usize,
    provenance: (&str, Option<&str>),
) -> Result<()> {
    let (origin, message) = provenance;
    bind_session(tx, ctx, epic, session)?;
    tx.execute(sql::INSERT_CHAIN, params![session, chain, epic])?;
    tx.execute(
        sql::INSERT,
        params![session, epic, chain, ordinal(index)?, origin, message],
    )?;
    Ok(())
}
fn elsewhere(db: &Connection, session: &str, epic: &str) -> Result<Option<Value>> {
    Ok(rows(db, sql::ELSEWHERE, params![epic, session])?
        .into_iter()
        .next())
}
fn held_elsewhere(
    tx: &Transaction<'_>,
    ctx: &Context,
    session: &str,
    other: &Value,
) -> Result<Value> {
    let epic = text(other, "epic_id")?;
    let op = format!(
        "canon-take:{session}:{epic}:{}:{}",
        text(other, "session_id")?,
        revision(tx, text(other, "session_id")?)?
    );
    record_intent(
        tx,
        ctx,
        &op,
        "canon_take_here",
        &json!({"session_id":session,"epic_id":epic,"epic_title":other["title"],"other_session_id":other["session_id"],"state":"pending"}),
    )?;
    Ok(json!({"ok":false,"code":"held_elsewhere","other_session":other["session_id"]}))
}

fn index(input: &Value, field: &str) -> Result<usize> {
    input[field]
        .as_u64()
        .and_then(|n| usize::try_from(n).ok())
        .ok_or(Error::Invalid("index"))
}
fn ordinal(value: usize) -> Result<i64> {
    i64::try_from(value).map_err(|_| Error::Invalid("index"))
}

/// Startup examines only unresolved running steps, through the live-state index.
pub fn running(db: &Connection) -> Result<Value> {
    Ok(json!(rows(db, sql::RUNNING, [])?))
}

/// Queue intents preserve transaction insertion order, including bundle order.
pub fn pending(db: &Connection) -> Result<Vec<Value>> {
    rows(db, sql::PENDING, [])
}

/// Every row is an unresolved cancellation identity; terminal receipts delete it.
pub fn cancellations(db: &Connection) -> Result<Value> {
    Ok(json!(rows(
        db,
        "SELECT op_id,source_session_id FROM canon_step_cancellations",
        []
    )?))
}
