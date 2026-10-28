use super::*;
use crate::{work_rank, work_types::*};
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone)]
pub struct NewWork {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub description: String,
    pub origin: Origin,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkFields {
    pub title: String,
    pub description: String,
    pub kind: Option<String>,
    pub assignee: Option<String>,
}
impl WorkFields {
    pub fn from_snapshot(value: &Value) -> Result<Self> {
        let value = value.clone();
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
    let Registration::Canon(_) = registration;
    tx.execute(
        sql::INSERT_PLAN,
        params![
            id,
            project,
            fields.title,
            fields.description,
            fields.due_on,
            fields.status.as_str(),
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
    insert_work_assigned(tx, ctx, input, registration, None, &[])
}

pub(super) fn insert_work_assigned(
    tx: &Transaction<'_>,
    ctx: &Context,
    input: &NewWork,
    registration: &Registration,
    assignee: Option<&str>,
    tags: &[String],
) -> Result<Value> {
    let Registration::Canon(_) = registration;
    crate::store::attachments::references(&input.description)?;
    api::tags::validate_creation(tx, &input.project_id, tags)?;
    tx.execute(
        sql::INSERT_WORK,
        params![
            input.id,
            input.project_id,
            input.title,
            input.description,
            input.origin.as_str(),
            ctx.now,
            ctx.actor.to_string(),
            assignee
        ],
    )?;
    for tag in tags {
        tx.execute(api::sql::ASSIGN_TAG, params![input.id, tag])?;
    }
    count(tx, ("project", &input.project_id), "epics", 1)?;
    let details = if tags.is_empty() {
        json!({})
    } else {
        json!({"tags": rows(tx, api::sql::EPIC_TAGS, [&input.id])?})
    };
    event_with_details(tx, ctx, ("work", &input.id, 0, "create"), &details)?;
    activity::append(tx, ctx, &input.id, "created", &input.title, None)?;
    read_work(tx, &input.id)
}
pub fn edit_work(
    tx: &Transaction<'_>,
    ctx: &Context,
    id: &str,
    expected_revision: i64,
    fields: &WorkFields,
) -> Result<Value> {
    crate::store::attachments::references(&fields.description)?;
    cas(&read_work(tx, id)?, "revision", expected_revision)?;
    tx.execute(
        sql::EDIT_WORK,
        params![
            id,
            fields.title,
            fields.description,
            fields.kind,
            fields.assignee,
            ctx.now,
            expected_revision
        ],
    )?;
    event(tx, ctx, "work", id, expected_revision + 1, "edit")?;
    read_work(tx, id)
}
pub fn bind_session(tx: &Transaction<'_>, ctx: &Context, id: &str, session: &str) -> Result<()> {
    bind_session_with_home(tx, ctx, id, session, true)
}
pub(super) fn bind_session_with_home(
    tx: &Transaction<'_>,
    ctx: &Context,
    id: &str,
    session: &str,
    home: bool,
) -> Result<()> {
    read_work(tx, id)?;
    let origin = if ctx.actor["via"] == "butler" {
        "butler"
    } else {
        "user"
    };
    if tx.execute(
        sql::BIND_SESSION,
        params![session, id, ctx.now, ctx.actor.to_string(), origin, home],
    )? > 0
    {
        event(
            tx,
            ctx,
            "work",
            id,
            read_work(tx, id)?["revision"]
                .as_i64()
                .ok_or(Error::Invalid("revision"))?,
            "bind_session",
        )?;
    }
    Ok(())
}
pub fn set_label(
    tx: &Transaction<'_>,
    ctx: &Context,
    id: &str,
    expected_revision: i64,
    label: CanonStatus,
    _person: &UserAct,
) -> Result<Value> {
    let old = read_work(tx, id)?;
    cas(&old, "revision", expected_revision)?;
    if label == CanonStatus::Done && runtime::epic_running(tx, id)? {
        return Err(Error::Running);
    }
    tx.execute(
        sql::LABEL,
        params![id, label.as_str(), ctx.now, expected_revision],
    )?;
    event(tx, ctx, "work", id, expected_revision + 1, "label")?;
    if old["canon_status"] != label.as_str() {
        activity::append(
            tx,
            ctx,
            id,
            "status",
            &format!(
                "{}→{}",
                old["canon_status"].as_str().unwrap_or_default(),
                label.as_str()
            ),
            None,
        )?;
    }
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
    if let Some(plan) = plan {
        let destination = read_plan(tx, plan)?;
        if destination["project_id"] != row["project_id"] {
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
