//! Task session identity and lease fencing, on the BTCC lane.
use super::*;
use rusqlite::params;

mod handoff;
pub mod sql;
pub(super) use handoff::clear_handoff;
pub use handoff::*;

#[derive(Debug, Clone)]
pub enum TaskSession {
    Own,
    Here(String),
}
impl TaskSession {
    pub fn for_creation(run_here: bool, session: &str) -> Self {
        if run_here {
            Self::Here(session.into())
        } else {
            Self::Own
        }
    }
}
pub(super) fn reserve_task_session(
    tx: &Transaction<'_>,
    ctx: &Context,
    task: &NewTask,
) -> Result<()> {
    let (reserved, owner) = match &task.session {
        TaskSession::Own => (Some(crate::work_ids::task_session_id(&task.id)), None),
        TaskSession::Here(session) => (None, Some(session.as_str())),
    };
    tx.execute(sql::RESERVE, params![task.id, reserved, owner])?;
    let op = format!("task_execution_context:{}", task.id);
    record_intent(tx, ctx, &op, "task_execution_context", &ctx.actor)?;
    mark_intent_applied(tx, ctx, &op, 0)?;
    Ok(())
}

/// Includes interrupted attempts so late callers receive the ownership fence,
/// rather than a misleading missing-lease error after a move.
pub fn ensure_owner_epoch(db: &Connection, task: &str, session: &str) -> Result<()> {
    let stale: bool = db.query_row(sql::STALE_OWNER, params![task, session], |r| r.get(0))?;
    if stale {
        return Err(Error::Invalid("stale_owner"));
    }
    Ok(())
}

/// Opening a reservation projects only its chat, without claiming or starting it.
pub fn open_task_session(tx: &Transaction<'_>, ctx: &Context, task: &str) -> Result<Value> {
    let row = read_task(tx, task)?;
    let session = row["reserved_session_id"]
        .as_str()
        .or(row["assignee_session_id"].as_str())
        .ok_or(Error::Invalid("Task has no session"))?;
    let work = read_work(tx, text(&row, "work_id")?)?;
    let coordinator = work["home_session_id"]
        .as_str()
        .unwrap_or(text(&work, "scope_ref")?);
    // Only the Task's allocated session needs projection. A conversation that
    // took ownership already exists and keeps its ordinary navigation identity.
    if session != crate::work_ids::task_session_id(task) {
        return Ok(json!({"session_id":session}));
    }
    record_intent(
        tx,
        ctx,
        &format!("task_session_chat:{task}"),
        "task_session_chat",
        &json!({"session_id":session,"task_id":task,"work_id":work["id"],
            "title":row["title"],"coordinator_session":coordinator}),
    )?;
    Ok(json!({"session_id":session}))
}

pub fn owned_elsewhere(db: &Connection, task: &str, session: &str) -> Result<Option<Value>> {
    let row = read_task(db, task)?;
    let owner = row["assignee_session_id"]
        .as_str()
        .or(row["reserved_session_id"].as_str());
    let Some(owner) = owner.filter(|owner| *owner != session) else {
        return Ok(None);
    };
    let state = if row["assignee_session_id"].is_null() {
        "reserved"
    } else {
        "running"
    };
    Ok(Some(
        json!({"task_id":task,"session_id":owner,"state":state,"revision":row["revision"],"owner_epoch":row["owner_epoch"],"title":row["title"]}),
    ))
}

/// The rejection is part of the tool transcript; BTCC ownership stays authoritative.
pub fn ownership_rejection(detail: &Value) -> Result<Value> {
    let message = ownership_message(detail, None)?;
    let mut error = detail.clone();
    error["code"] = json!("owned_elsewhere");
    error["message"] = json!(message);
    Ok(json!({"ok":false,"error":error}))
}

/// App presentation can resolve a conversation title without changing the receipt.
pub fn ownership_message(detail: &Value, title: Option<&str>) -> Result<String> {
    let task = text(detail, "task_id")?;
    let state = text(detail, "state")?;
    let Some(title) = title else {
        return Ok(format!(
            "Task {task} is planned to run in its own conversation. The user now sees a card to open that conversation or do it here. Tell them in one line and wait for their choice. Do not retry task.start or work around it."
        ));
    };
    Ok(if state == "running" {
        format!(
            "Task {task} is running in another conversation, ‘{title}’. The user now sees a card to open that conversation or move the Task here. Tell them in one line and wait for their choice. Do not retry task.start or work around it."
        )
    } else {
        format!(
            "Task {task} is planned to run in another conversation, ‘{title}’. The user now sees a card to open that conversation or do it here. Tell them in one line and wait for their choice. Do not retry task.start or work around it."
        )
    })
}

/// Projection acknowledgements may race another drain; the writer lane reads
/// their current revision before applying the strict intent CAS.
pub fn acknowledge_intent(tx: &Transaction<'_>, ctx: &Context, op: &str) -> Result<()> {
    let row = one(tx, super::sql::INTENT, [op])?;
    if row["state"] == "pending" {
        mark_intent_applied(
            tx,
            ctx,
            op,
            row["revision"].as_i64().ok_or(Error::Invalid("revision"))?,
        )?;
    }
    Ok(())
}

/// Fence part mutations while ownership is settling as well as after its epoch moves.
pub fn ensure_owner_mutation(db: &Connection, task: &str, session: &str) -> Result<()> {
    ensure_owner_epoch(db, task, session)?;
    if !read_task(db, task)?["handoff_to_session_id"].is_null() {
        return Err(Error::Invalid("handoff_in_progress"));
    }
    Ok(())
}
