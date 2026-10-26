use super::*;
mod project_history;

fn latest(db: &Connection, query: Query, work: &str) -> Result<Option<Value>> {
    Ok(rows(db, query.sql(), [work])?.into_iter().next())
}

pub(super) fn running(db: &Connection, work: &Value) -> Result<bool> {
    if work["status"] != "open" {
        return Ok(false);
    }
    let own = db
        .query_row(Query::OwnActive.sql(), [text(work, "session_id")?], |_| {
            Ok(())
        })
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
    for work in &works {
        let id = text(work, "work_id")?;
        if running(db, work)? {
            result["running"] = json!(true);
        }
        let checkpoints = checkpoints(db, work, views)?;
        let stage = checkpoints
            .last()
            .map(|c| c["stage"].clone())
            .unwrap_or(json!("conception"));
        if active.is_none() || work["status"] == "open" || active == Some(false) {
            result["stage"] = stage;
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
                .and_then(Value::as_str)
                .ok_or(Error::Invalid("epic id"))?;
            let progress = progress(db, id, views)?;
            object.insert("task_counts".into(), progress["counts"].clone());
            object.insert("running".into(), progress["running"].clone());
        }
        for key in ["backlog", "plans", "works", "groups", "rows", "work"] {
            if let Some(child) = object.get_mut(key) {
                enrich(db, child, views)?;
            }
        }
    }
    Ok(())
}

pub(super) fn reported(db: &Connection, work: &Value, views: &ProjectViews) -> Result<bool> {
    let id = text(work, "work_id")?;
    let disposition = disposition(db, work, views)?;
    let (review, checkpoint) = if work["scope_kind"] == "project" {
        let Some(view) = views.get(id) else {
            return Ok(false);
        };
        (
            view["latestCompletionValidation"].clone(),
            view["latestCheckpoint"].clone(),
        )
    } else {
        (
            latest(db, Query::Review, id)?.unwrap_or(Value::Null),
            rows(db, Query::Checkpoints.sql(), [id])?
                .pop()
                .unwrap_or(Value::Null),
        )
    };
    let reviewed = review["subject"] == "completion" && review["verdict"] == "accept";
    if disposition["disposition"] != "completed"
        || checkpoint["stage"] != "reporting"
        || !(reviewed || delegated_completion(db, work, views)?)
    {
        return Ok(false);
    }
    let finished = |value: &Value| -> Result<bool> {
        let turn = value
            .get("originTurnId")
            .or_else(|| value.get("origin_turn_id"))
            .and_then(Value::as_str)
            .ok_or(Error::Invalid("origin turn"))?;
        let state: Option<String> = db
            .query_row(Query::Turn.sql(), [turn], |r| r.get(0))
            .optional()?;
        Ok(state.as_deref() == Some("delivered"))
    };
    Ok(finished(&checkpoint)? && finished(&disposition)?)
}

/// A delegated parent's closeout belongs to its Steward's terminal result.
fn delegated_completion(db: &Connection, work: &Value, views: &ProjectViews) -> Result<bool> {
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
        return Ok(false);
    };
    if plan
        .get("executionMode")
        .or_else(|| plan.get("execution_mode"))
        .and_then(Value::as_str)
        != Some("steward")
    {
        return Ok(false);
    }
    let plan_id = plan
        .get("planRevisionId")
        .or_else(|| plan.get("plan_revision_id"))
        .and_then(Value::as_str)
        .ok_or(Error::Invalid("delegated plan id"))?;
    Ok(db
        .query_row(
            Query::DelegatedCompletion.sql(),
            params![id, plan_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
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
        for key in ["backlog", "plans", "works", "groups", "rows", "work"] {
            if let Some(child) = object.get(key) {
                works.extend(project_works(db, child)?);
            }
        }
    }
    Ok(works)
}
