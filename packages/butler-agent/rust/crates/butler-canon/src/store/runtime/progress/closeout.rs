//! Canon's reading of a Work's closeout. BTCC decides which reviews a Work needs
//! before it may close; canon only decides whether that closeout finishes a 과제.
use super::*;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Closeout {
    /// Nothing is closed yet, or the Turn that reports the closeout is still running.
    Pending,
    /// The Work closed as completed, but its own record says otherwise.
    Refused,
    /// Finished: only a person's review of the 과제 remains.
    Reported,
}

/// How a closed Work's Steward stands, when its plan delegated at all.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Delegation {
    /// The Work did its own work.
    None,
    /// The Steward is running or has a direction still to take up.
    Open,
    /// The Steward ended without finishing.
    Failed,
    Finished,
}

pub(super) fn read(db: &Connection, work: &Value, views: &ProjectViews) -> Result<Closeout> {
    let closing = disposition(db, work, views)?;
    if closing["disposition"] != "completed" || !delivered(db, &closing)? {
        return Ok(Closeout::Pending);
    }
    if !reviews_accept(db, work, views)? {
        return Ok(Closeout::Refused);
    }
    match delegation(db, work, views)? {
        Delegation::Open => return Ok(Closeout::Pending),
        Delegation::Failed => return Ok(Closeout::Refused),
        Delegation::None if nothing_done(db, work, views)? => return Ok(Closeout::Refused),
        Delegation::None => return Ok(Closeout::Reported),
        Delegation::Finished => {}
    }
    // A Steward closes a delegated parent early: Butler's report is its reporting checkpoint.
    let id = text(work, "work_id")?;
    let checkpoint = if work["scope_kind"] == "project" {
        views
            .get(id)
            .map_or(Value::Null, |view| view["latestCheckpoint"].clone())
    } else {
        rows(db, Query::Checkpoints.sql(), [id])?
            .pop()
            .unwrap_or(Value::Null)
    };
    Ok(
        if checkpoint["stage"] == "reporting" && delivered(db, &checkpoint)? {
            Closeout::Reported
        } else {
            Closeout::Pending
        },
    )
}

fn delivered(db: &Connection, record: &Value) -> Result<bool> {
    let turn = record
        .get("originTurnId")
        .or_else(|| record.get("origin_turn_id"))
        .and_then(Value::as_str)
        .ok_or(Error::Invalid("origin turn"))?;
    let state: Option<String> = db
        .query_row(Query::Turn.sql(), [turn], |r| r.get(0))
        .optional()?;
    Ok(state.as_deref() == Some("delivered"))
}

/// A review that asked for changes stands until a later review accepts.
fn reviews_accept(db: &Connection, work: &Value, views: &ProjectViews) -> Result<bool> {
    let id = text(work, "work_id")?;
    if work["scope_kind"] != "project" {
        return Ok(rows(db, Query::CloseoutReview.sql(), [id])?
            .first()
            .is_none_or(|review| review["verdict"] == "accept"));
    }
    let Some(view) = views.get(id) else {
        return Ok(true);
    };
    Ok(["latestResultReview", "latestCompletionValidation"]
        .into_iter()
        .map(|key| &view[key])
        .filter(|review| !review.is_null())
        .max_by_key(|review| review["revision"].as_u64())
        .is_none_or(|review| review["verdict"] == "accept"))
}

/// Skipping everything with no tool result is not finished work. Doing an action
/// in prose is: answering leaves no tool result behind.
fn nothing_done(db: &Connection, work: &Value, views: &ProjectViews) -> Result<bool> {
    let id = text(work, "work_id")?;
    let results = if work["scope_kind"] == "project" {
        views
            .get(id)
            .and_then(|view| view["resultRefs"].as_array())
            .is_some_and(|refs| !refs.is_empty())
    } else {
        db.query_row(Query::HasResult.sql(), [id], |_| Ok(()))
            .optional()?
            .is_some()
    };
    Ok(!results
        && !work_actions(db, work, views)?
            .iter()
            .any(|action| action["status"] == "done"))
}

/// A delegated parent's closeout belongs to its Steward's terminal result.
fn delegation(db: &Connection, work: &Value, views: &ProjectViews) -> Result<Delegation> {
    let id = text(work, "work_id")?;
    let plan = if work["scope_kind"] == "project" {
        views
            .get(id)
            .and_then(|view| view.get("currentPlan"))
            .cloned()
    } else {
        latest(db, Query::Plan, id)?
    };
    let Some(plan) = plan else {
        return Ok(Delegation::None);
    };
    if plan
        .get("executionMode")
        .or_else(|| plan.get("execution_mode"))
        .and_then(Value::as_str)
        != Some("steward")
    {
        return Ok(Delegation::None);
    }
    let plan_id = plan
        .get("planRevisionId")
        .or_else(|| plan.get("plan_revision_id"))
        .and_then(Value::as_str)
        .ok_or(Error::Invalid("delegated plan id"))?;
    let exists = |query: Query, args: &[&dyn rusqlite::ToSql]| -> Result<bool> {
        Ok(db
            .query_row(query.sql(), args, |_| Ok(()))
            .optional()?
            .is_some())
    };
    if exists(Query::DelegatedCompletion, params![id, plan_id])? {
        return Ok(Delegation::Finished);
    }
    if exists(Query::DelegatedActive, params![id])?
        || exists(Query::DelegatedDirectionPending, params![id])?
    {
        return Ok(Delegation::Open);
    }
    Ok(if exists(Query::DelegatedAny, params![id, plan_id])? {
        Delegation::Failed
    } else {
        Delegation::None
    })
}
