use super::*;
use crate::{work_rank, work_types::*};
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone)]
pub struct NewWork {
    pub id: String,
    pub scope_kind: ScopeKind,
    pub scope_ref: String,
    pub title: String,
    pub description: String,
    pub origin: Origin,
    pub draft: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkFields {
    pub title: String,
    pub description: String,
    pub kind: Option<String>,
    pub assignee: Option<String>,
    pub draft: bool,
    pub tier: i64,
}
impl WorkFields {
    pub fn from_snapshot(value: &Value) -> Result<Self> {
        let mut value = value.clone();
        value["draft"] = json!(value["draft"] == 1);
        Ok(serde_json::from_value(value)?)
    }
}
#[derive(Debug, Clone)]
pub struct PlanFields {
    pub title: String,
    pub description: String,
    pub due_on: Option<String>,
    pub status: PlanStatus,
}
pub fn read_work(db: &Connection, id: &str) -> Result<Value> {
    one(db, sql::WORK, [id])
}
pub fn read_plan(db: &Connection, id: &str) -> Result<Value> {
    one(db, sql::PLAN, [id])
}
pub fn create_plan(
    tx: &Transaction<'_>,
    ctx: &Context,
    id: &str,
    project: &str,
    fields: &PlanFields,
    registration: &Registration,
) -> Result<Value> {
    let visibility = match registration {
        Registration::Private => "private",
        Registration::Canon(_) => "canon",
    };
    tx.execute(
        sql::INSERT_PLAN,
        params![
            id,
            project,
            fields.title,
            fields.description,
            fields.due_on,
            fields.status.as_str(),
            visibility,
            ctx.now,
            ctx.actor.to_string()
        ],
    )?;
    count(tx, ("project", project), "plans", 1)?;
    event(tx, ctx, "plan", id, 0, "create")?;
    read_plan(tx, id)
}
pub fn edit_plan(
    tx: &Transaction<'_>,
    ctx: &Context,
    id: &str,
    expected_revision: i64,
    fields: &PlanFields,
) -> Result<Value> {
    cas(&read_plan(tx, id)?, "revision", expected_revision)?;
    tx.execute(
        sql::EDIT_PLAN,
        params![
            id,
            fields.title,
            fields.description,
            fields.due_on,
            fields.status.as_str(),
            ctx.now,
            expected_revision
        ],
    )?;
    event(tx, ctx, "plan", id, expected_revision + 1, "edit")?;
    read_plan(tx, id)
}
pub fn create_work(
    tx: &Transaction<'_>,
    ctx: &Context,
    input: &NewWork,
    registration: &Registration,
) -> Result<Value> {
    ensure_work_counts(tx, (input.scope_kind.as_str(), &input.scope_ref))?;
    let (visibility, status) = match registration {
        Registration::Private => ("private", None),
        Registration::Canon(_) => ("canon", Some("planned")),
    };
    tx.execute(
        sql::INSERT_WORK,
        params![
            input.id,
            input.scope_kind.as_str(),
            input.scope_ref,
            input.title,
            input.description,
            input.origin.as_str(),
            input.draft,
            visibility,
            status,
            ctx.now,
            ctx.actor.to_string()
        ],
    )?;
    count(
        tx,
        (input.scope_kind.as_str(), &input.scope_ref),
        "works",
        1,
    )?;
    count(
        tx,
        (input.scope_kind.as_str(), &input.scope_ref),
        "run_state:idle",
        1,
    )?;
    event(tx, ctx, "work", &input.id, 0, "create")?;
    read_work(tx, &input.id)
}
pub fn edit_work(
    tx: &Transaction<'_>,
    ctx: &Context,
    id: &str,
    expected_revision: i64,
    fields: &WorkFields,
) -> Result<Value> {
    cas(&read_work(tx, id)?, "revision", expected_revision)?;
    tx.execute(
        sql::EDIT_WORK,
        params![
            id,
            fields.title,
            fields.description,
            fields.kind,
            fields.assignee,
            fields.draft,
            fields.tier,
            ctx.now,
            expected_revision
        ],
    )?;
    event(tx, ctx, "work", id, expected_revision + 1, "edit")?;
    read_work(tx, id)
}
pub fn assign_home(
    tx: &Transaction<'_>,
    ctx: &Context,
    id: &str,
    expected_revision: i64,
    home: Option<&str>,
) -> Result<Value> {
    let row = read_work(tx, id)?;
    cas(&row, "revision", expected_revision)?;
    if let (Some(chain), Some(home)) = (row["chain_id"].as_str(), home)
        && load_chain(tx, chain)?.session_id != home
    {
        return Err(Error::CrossChat);
    }
    tx.execute(sql::HOME, params![id, home, ctx.now, expected_revision])
        .map_err(|err| {
            if err
                .sqlite_error()
                .is_some_and(|e| e.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE)
            {
                Error::ConversationOccupied
            } else {
                Error::Sqlite(err)
            }
        })?;
    event(tx, ctx, "work", id, expected_revision + 1, "assign_home")?;
    read_work(tx, id)
}
/// Bounds are ranks in the destination Plan/backlog. Canon ordering is separate
/// from queue membership; it never changes prerequisites.
pub fn set_plan_rank(
    tx: &Transaction<'_>,
    ctx: &Context,
    id: &str,
    expected_revision: i64,
    plan: Option<&str>,
    lower: Option<&str>,
    upper: Option<&str>,
) -> Result<Value> {
    let row = read_work(tx, id)?;
    cas(&row, "revision", expected_revision)?;
    if row["visibility"] != "canon" {
        return Err(Error::Invalid("private Work has no canon order"));
    }
    if let Some(plan) = plan {
        let destination = read_plan(tx, plan)?;
        if row["scope_kind"] != "project" || destination["project_id"] != row["scope_ref"] {
            return Err(Error::Invalid("Plan belongs to another project"));
        }
    }
    let rank = work_rank::between(lower, upper).ok_or(Error::InvalidRank)?;
    tx.execute(
        sql::RANK,
        params![id, plan, rank, ctx.now, expected_revision],
    )?;
    event(tx, ctx, "work", id, expected_revision + 1, "reorder")?;
    read_work(tx, id)
}
