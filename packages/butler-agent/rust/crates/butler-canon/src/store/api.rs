//! Local API operations, called inside the BTCC read or writer lane.
mod canon;
pub mod canon_conversation;
mod epic_delete;
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
use Resource::{
    Activity, AllowGrant, BacklogOrder, Canon, CheckCriterion, Comment, CreateEpic, CreatePlan,
    CreateTag, DeleteEpic, DeleteTag, DenyGrant, EditEpic, EditPlan, EditTag, Epic, Grants, List,
    Plan, PlanOrder, ProposeSpec, RevokeGrant, Spec, Tags,
};
pub use reads::{canon, epic, epic_only, plan};

#[derive(Clone, Copy, Debug)]
pub enum Resource {
    Canon,
    List,
    Spec,
    Activity,
    Comment,
    ProposeSpec,
    CheckCriterion,
    Grants,
    AllowGrant,
    DenyGrant,
    RevokeGrant,
    Plan,
    Epic,
    CreatePlan,
    EditPlan,
    CreateEpic,
    EditEpic,
    DeleteEpic,
    PlanOrder,
    BacklogOrder,
    Tags,
    CreateTag,
    EditTag,
    DeleteTag,
}

/// Identity-only PK lookups, shared by reads and edits before App project checks.
pub fn project_scope(db: &Connection, resource: Resource, id: &str) -> Result<String> {
    let sql = match resource {
        List | Grants | AllowGrant | DenyGrant | RevokeGrant => return Ok(id.into()),
        Spec | ProposeSpec | CheckCriterion => {
            "SELECT scope_ref FROM canon_spec_nodes WHERE node_id=?1 AND scope_kind='project' AND visibility='canon'"
        }
        Activity | Comment | Epic | EditEpic | DeleteEpic => sql::EPIC_SCOPE,
        Plan | EditPlan | PlanOrder => sql::PLAN_SCOPE,
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
        Spec => mcp_proposals::spec(db, id),
        Activity => activity::page(db, id, None),
        List | Grants | AllowGrant | DenyGrant | RevokeGrant | Comment | ProposeSpec
        | CheckCriterion => Err(Error::Invalid("request input required")),
        Tags => tags::list(db, id),
        Canon => canon(db, id),
        Plan => plan(db, id),
        Epic => epic(db, id),
        CreatePlan | EditPlan | CreateEpic | EditEpic | DeleteEpic | PlanOrder | BacklogOrder
        | CreateTag | EditTag | DeleteTag => {
            Err(Error::Invalid("read requires a readable resource"))
        }
    }
}
pub fn read_query(db: &Connection, resource: Resource, id: &str, input: &Value) -> Result<Value> {
    match resource {
        Resource::List => page::list(db, id, input),
        Resource::Activity => activity::page(db, id, input["before"].as_i64()),
        Resource::Grants => grants::list(db, input["state"].as_str()),
        _ => read(db, resource, id),
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
        List => page::list(tx, id, &input),
        Spec => mcp_proposals::spec(tx, id),
        Activity => activity::page(tx, id, input["before"].as_i64()),
        Comment => activity::comment(tx, ctx, id, input),
        CheckCriterion => criteria::toggle(tx, ctx, id, input),
        ProposeSpec => mcp_proposals::create(tx, ctx, id, input),
        Grants => grants::list(tx, input["state"].as_str()),
        AllowGrant => grants::decide(tx, ctx, id, "allowed"),
        DenyGrant => grants::decide(tx, ctx, id, "denied"),
        RevokeGrant => grants::decide(tx, ctx, id, "revoked"),
        CreateTag => tags::create(tx, ctx, id, input),
        EditTag => tags::edit(tx, ctx, id, input),
        DeleteTag => tags::delete(tx, ctx, id),
        CreatePlan => canon::create_plan(tx, ctx, id, input),
        EditPlan => canon::edit_plan(tx, ctx, id, input),
        CreateEpic => canon::create_epic(tx, ctx, id, input),
        EditEpic => canon::edit_epic(tx, ctx, id, input),
        DeleteEpic => epic_delete::delete(tx, ctx, id, input),
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
