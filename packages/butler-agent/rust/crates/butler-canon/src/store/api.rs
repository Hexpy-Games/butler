//! Local API operations, called inside the BTCC read or writer lane.
mod canon;
pub mod canon_conversation;
mod outbox;
pub(super) use outbox::append as outbox;
mod reads;
pub mod sql;
pub mod tags;
use super::*;
use crate::{
    work_ids::{IdGenerator, IdKind},
    work_queries::Query,
    work_types::*,
};
pub use reads::{canon, epic, plan};

#[derive(Clone, Copy, Debug)]
pub enum Resource {
    Canon,
    Plan,
    Epic,
    CreatePlan,
    EditPlan,
    CreateEpic,
    EditEpic,
    PlanOrder,
    BacklogOrder,
    Tags,
    CreateTag,
    EditTag,
    DeleteTag,
}
use Resource::{
    BacklogOrder, Canon, CreateEpic, CreatePlan, CreateTag, DeleteTag, EditEpic, EditPlan, EditTag,
    Epic, Plan, PlanOrder, Tags,
};

/// Identity-only PK lookups, shared by reads and edits before App project checks.
pub fn project_scope(db: &Connection, resource: Resource, id: &str) -> Result<String> {
    let sql = match resource {
        Plan | EditPlan | PlanOrder => sql::PLAN_SCOPE,
        Epic | EditEpic => sql::EPIC_SCOPE,
        EditTag | DeleteTag => sql::TAG_SCOPE,
        Canon | CreatePlan | CreateEpic | BacklogOrder | Tags | CreateTag => {
            return Ok(id.to_owned());
        }
    };
    db.query_row(sql, [id], |row| row.get(0))
        .optional()?
        .ok_or(Error::NotFound)
}

pub fn read(db: &Connection, resource: Resource, id: &str) -> Result<Value> {
    match resource {
        Tags => tags::list(db, id),
        Canon => canon(db, id),
        Plan => plan(db, id),
        Epic => epic(db, id),
        CreatePlan | EditPlan | CreateEpic | EditEpic | PlanOrder | BacklogOrder | CreateTag
        | EditTag | DeleteTag => Err(Error::Invalid("read requires a readable resource")),
    }
}
pub fn write(
    tx: &Transaction<'_>,
    ctx: &Context,
    resource: Resource,
    id: &str,
    input: Value,
) -> Result<Value> {
    match resource {
        CreateTag => tags::create(tx, ctx, id, input),
        EditTag => tags::edit(tx, ctx, id, input),
        DeleteTag => tags::delete(tx, ctx, id),
        CreatePlan => canon::create_plan(tx, ctx, id, input),
        EditPlan => canon::edit_plan(tx, ctx, id, input),
        CreateEpic => canon::create_epic(tx, ctx, id, input),
        EditEpic => canon::edit_epic(tx, ctx, id, input),
        PlanOrder => canon::order(tx, ctx, Some(id), id, input),
        BacklogOrder => canon::order(tx, ctx, None, id, input),
        Canon | Plan | Epic | Tags => Err(Error::Invalid("write requires an editable resource")),
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
    Ok(row)
}

/// Acknowledgements are idempotent and use the outbox primary key.
pub fn mark_outbox_published(tx: &Transaction<'_>, seqs: &[i64]) -> Result<()> {
    for seq in seqs {
        tx.execute(sql::PUBLISHED, [seq])?;
    }
    Ok(())
}
