//! Local API operations, called inside the BTCC read or writer lane.
mod canon;
mod outbox;
pub(super) use outbox::append as outbox;
mod queue;
mod reads;
pub mod sql;
use super::*;
use crate::{
    work_ids::{IdGenerator, IdKind},
    work_queries::Query,
    work_types::*,
};
pub use reads::{canon, epic, plan, queue};

pub fn read(db: &Connection, resource: &str, id: &str) -> Result<Value> {
    match resource {
        "queue" => queue(db, id),
        "canon" => canon(db, id),
        "plan" => plan(db, id),
        "epic" => epic(db, id),
        _ => Err(Error::NotFound),
    }
}
pub fn write(
    tx: &Transaction<'_>,
    ctx: &Context,
    resource: &str,
    id: &str,
    input: Value,
) -> Result<Value> {
    match resource {
        "queue" => queue::edit(tx, ctx, id, input),
        "create_plan" => canon::create_plan(tx, ctx, id, input),
        "edit_plan" => canon::edit_plan(tx, ctx, id, input),
        "create_epic" => canon::create_epic(tx, ctx, id, input),
        "edit_epic" => canon::edit_epic(tx, ctx, id, input),
        "plan_order" => canon::order(tx, ctx, Some(id), id, input),
        "backlog_order" => canon::order(tx, ctx, None, id, input),
        _ => Err(Error::NotFound),
    }
}
fn input<T: serde::de::DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value).map_err(|_| Error::Invalid("invalid request fields"))
}
fn revision(row: &Value) -> Result<i64> {
    row["revision"].as_i64().ok_or(Error::Invalid("revision"))
}
fn title(value: &str) -> Result<()> {
    if value.trim().is_empty() {
        return Err(Error::Invalid("title required"));
    }
    Ok(())
}
fn canon_row(row: Value) -> Result<Value> {
    if row["visibility"] != "canon" {
        return Err(Error::NotFound);
    }
    Ok(row)
}

/// Acknowledgements are idempotent and use the outbox primary key.
pub fn mark_outbox_published(tx: &Transaction<'_>, seqs: &[i64]) -> Result<()> {
    for seq in seqs {
        tx.execute(sql::PUBLISHED, [seq])?;
    }
    Ok(())
}
