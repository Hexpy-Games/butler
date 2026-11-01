use super::*;
mod closeout;
mod project_history;
use closeout::Closeout;

fn latest(db: &Connection, query: Query, work: &str) -> Result<Option<Value>> {
    Ok(rows(db, query.sql(), [work])?.into_iter().next())
}

pub(super) fn running(db: &Connection, work: &Value) -> Result<bool> {
    if work["status"] != "open" {
        return Ok(false);
    }
    let session = text(work, "session_id")?;
    // 그래도 진행 leaves the stopped step's Work open; later Turns belong to other steps.
    let continued = db
        .query_row(
            Query::QueueContinued.sql(),
            params![session, text(work, "epic_id")?],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    let own = !continued
        && db
            .query_row(Query::OwnActive.sql(), [session], |_| Ok(()))
            .optional()?
            .is_some();
    let child = db
        .query_row(
            Query::DelegatedActive.sql(),
            [text(work, "work_id")?],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    Ok(own || child)
}

fn actions(db: &Connection, work: &str) -> Result<Vec<Value>> {
    let Some(plan) = latest(db, Query::Plan, work)? else {
        return Ok(Vec::new());
    };
    let checkpoint = rows(
        db,
        Query::PlanCheckpoint.sql(),
        params![work, text(&plan, "plan_revision_id")?],
    )?
    .into_iter()
    .next();
    let states: Vec<Value> = checkpoint
        .map(|c| serde_json::from_str(text(&c, "action_states_json")?).map_err(Error::from))
        .transpose()?
        .unwrap_or_default();
    let mut actions: Vec<Value> = serde_json::from_str(text(&plan, "actions_json")?)?;
    for action in &mut actions {
        let state = states
            .iter()
            .find(|s| s["actionKey"] == action["actionKey"]);
        action["work_id"] = json!(work);
        action["status"] = state
            .map(|s| s["status"].clone())
            .unwrap_or(json!("pending"));
        if let Some(note) = state.and_then(|s| s.get("note")) {
            action["note"] = note.clone();
        }
    }
    Ok(actions)
}

pub fn progress(db: &Connection, epic: &str, views: &ProjectViews) -> Result<Value> {
    read_work(db, epic)?;
    let works = rows(db, Query::Works.sql(), [epic])?;
    let mut result = json!({"epic_id":epic,"stage":null,"stage_history":[],"actions":[],"counts":{"completed":0,"total":0},"running":false,"disposition":null});
    let mut current_actions = Vec::new();
    let mut history = Vec::new();
    let mut active = None;
    for (index, work) in works.iter().enumerate() {
        let id = text(work, "work_id")?;
        // A later Work in the same conversation replaced this one, even if it was left open.
        let current = !works[index + 1..]
            .iter()
            .any(|later| later["session_id"] == work["session_id"]);
        if current && running(db, work)? {
            result["running"] = json!(true);
        }
        let checkpoints = checkpoints(db, work, views)?;
        if current && (active.is_none() || work["status"] == "open" || active == Some(false)) {
            result["stage"] = if closeout::read(db, work, views)? == Closeout::Reported {
                json!("reporting")
            } else {
                checkpoints
                    .last()
                    .map(|c| c["stage"].clone())
                    .unwrap_or(json!("conception"))
            };
            active = Some(work["status"] == "open");
            current_actions = work_actions(db, work, views)?;
            result["disposition"] = disposition(db, work, views)?["disposition"].clone();
        }
        for checkpoint in checkpoints {
            history.push(json!({"work_id":id,"revision":checkpoint["revision"],"stage":checkpoint["stage"],"summary":checkpoint["public_summary"],"created_at":checkpoint["created_at"]}));
        }
    }
    result["counts"] = json!({"completed":current_actions.iter().filter(|a| a["status"] == "done").count(),"total":current_actions.len()});
    result["actions"] = json!(current_actions);
    result["stage_history"] = json!(history);
    Ok(result)
}

/// Adds derived card data on the same read snapshot as the canon response.
pub fn enrich(db: &Connection, value: &mut Value, views: &ProjectViews) -> Result<()> {
    if let Some(items) = value.as_array_mut() {
        for item in items {
            enrich(db, item, views)?;
        }
    } else if let Some(object) = value.as_object_mut() {
        if object.contains_key("canon_status") {
            let id = object
                .get("id")
                .or_else(|| object.get("epic_id"))
                .and_then(Value::as_str)
                .ok_or(Error::Invalid("epic id"))?;
            let progress = progress(db, id, views)?;
            if object.contains_key("epic_id") {
                object.insert("progress".into(), progress);
            } else {
                let queue = queue_item(db, id, object.get("home_session_id"))?;
                object.insert("queue".into(), queue);
                object.insert("task_counts".into(), progress["counts"].clone());
                object.insert("running".into(), progress["running"].clone());
            }
        }
        for key in [
            "backlog", "plans", "works", "groups", "rows", "work", "chains", "steps", "items",
        ] {
            if let Some(child) = object.get_mut(key) {
                enrich(db, child, views)?;
            }
        }
    }
    Ok(())
}

/// The 과제's place in its home conversation's queue, which says who shows that chat's state.
fn queue_item(db: &Connection, epic: &str, home: Option<&Value>) -> Result<Value> {
    let Some(home) = home.and_then(Value::as_str) else {
        return Ok(Value::Null);
    };
    Ok(rows(db, Query::QueueItem.sql(), params![home, epic])?
        .first()
        .map_or(Value::Null, |item| {
            json!({"state":item["state"],"hold":!item["hold_reason"].is_null(),"finished_at":item["finished_at"]})
        }))
}

pub(super) fn reported(db: &Connection, work: &Value, views: &ProjectViews) -> Result<bool> {
    Ok(closeout::read(db, work, views)? == Closeout::Reported)
}

fn disposition(db: &Connection, work: &Value, views: &ProjectViews) -> Result<Value> {
    let id = text(work, "work_id")?;
    if work["scope_kind"] == "project" {
        Ok(views
            .get(id)
            .map(|view| view["latestDisposition"].clone())
            .unwrap_or(Value::Null))
    } else {
        Ok(latest(db, Query::Disposition, id)?.unwrap_or(Value::Null))
    }
}

fn work_actions(db: &Connection, work: &Value, views: &ProjectViews) -> Result<Vec<Value>> {
    let id = text(work, "work_id")?;
    if work["scope_kind"] != "project" {
        return actions(db, id);
    }
    let Some(view) = views.get(id) else {
        return Ok(Vec::new());
    };
    let mut actions = view["currentPlan"]["actions"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    for action in &mut actions {
        let state = view["actionProgress"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|s| s["actionKey"] == action["actionKey"]);
        action["work_id"] = json!(id);
        action["status"] = state
            .map(|s| s["status"].clone())
            .unwrap_or(json!("pending"));
        if let Some(note) = state.and_then(|s| s.get("note")) {
            action["note"] = note.clone();
        }
    }
    Ok(actions)
}

fn checkpoints(db: &Connection, work: &Value, views: &ProjectViews) -> Result<Vec<Value>> {
    if work["scope_kind"] != "project" {
        return rows(db, Query::Checkpoints.sql(), [text(work, "work_id")?]);
    }
    project_history::read(db, work, views)
}

/// Only project Works belonging to the requested epics; the host reads each once.
pub fn project_works(db: &Connection, value: &Value) -> Result<Vec<Value>> {
    let mut works = Vec::new();
    if let Some(items) = value.as_array() {
        for item in items {
            works.extend(project_works(db, item)?);
        }
    } else if let Some(object) = value.as_object() {
        let id = object.get("epic_id").or_else(|| {
            object
                .contains_key("canon_status")
                .then(|| object.get("id"))
                .flatten()
        });
        if let Some(id) = id.and_then(Value::as_str) {
            works.extend(rows(db, Query::Works.sql(), [id])?);
        }
        for key in [
            "backlog", "plans", "works", "groups", "rows", "work", "chains", "steps", "items",
        ] {
            if let Some(child) = object.get(key) {
                works.extend(project_works(db, child)?);
            }
        }
    }
    Ok(works)
}

/// A step's Turn ended: it stays unfinished when no Work closed and nothing delegated
/// for this step can still close one. Another step's Steward says nothing about this
/// one. A closed Work settles through its closeout instead.
pub(crate) fn step_unfinished(
    db: &Connection,
    epic: &str,
    session: &str,
    started: i64,
    turn: Option<&str>,
) -> Result<bool> {
    let works = rows(
        db,
        crate::store::queue::sql::LINKED_WORK,
        params![epic, session, started],
    )?;
    let work = works.first();
    if work.is_some_and(|work| work["status"] != "open") {
        return Ok(false);
    }
    let by_turn = match turn {
        Some(turn) => db
            .query_row(Query::TurnDelegationOpen.sql(), [session, turn], |_| Ok(()))
            .optional()?
            .is_some(),
        None => false,
    };
    let by_work = match work {
        Some(work) => db
            .query_row(
                Query::WorkDelegationOpen.sql(),
                [text(work, "work_id")?],
                |_| Ok(()),
            )
            .optional()?
            .is_some(),
        None => false,
    };
    Ok(!by_turn && !by_work)
}

/// Only links created in this run and this exact runtime session can settle it.
pub(crate) fn queue_outcome(
    db: &Connection,
    epic: &str,
    session: &str,
    started: i64,
    views: &ProjectViews,
) -> Result<Option<Value>> {
    let works = rows(
        db,
        crate::store::queue::sql::LINKED_WORK,
        params![epic, session, started],
    )?;
    works
        .first()
        .map(|work| {
            let closeout = closeout::read(db, work, views)?;
            let failed = matches!(work["status"].as_str(), Some("blocked" | "abandoned"))
                || disposition(db, work, views)?["disposition"] == "blocked"
                || closeout == Closeout::Refused;
            Ok(json!({"work_id":work["work_id"],"reported":closeout == Closeout::Reported,"failed":failed}))
        })
        .transpose()
}
