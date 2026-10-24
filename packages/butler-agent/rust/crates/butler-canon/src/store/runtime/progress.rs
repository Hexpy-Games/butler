use super::*;

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

pub fn progress(db: &Connection, epic: &str) -> Result<Value> {
    read_work(db, epic)?;
    let works = rows(db, Query::Works.sql(), [epic])?;
    let mut result = json!({"epic_id":epic,"stage":null,"stage_history":[],"actions":[],"counts":{"completed":0,"total":0},"running":false,"disposition":null});
    let mut all_actions = Vec::new();
    let mut history = Vec::new();
    let mut active = None;
    for work in &works {
        let id = text(work, "work_id")?;
        if running(db, work)? {
            result["running"] = json!(true);
        }
        let checkpoints = rows(db, Query::Checkpoints.sql(), [id])?;
        let stage = checkpoints
            .last()
            .map(|c| c["stage"].clone())
            .unwrap_or(json!("conception"));
        if active.is_none() || work["status"] == "open" || active == Some(false) {
            result["stage"] = stage;
            active = Some(work["status"] == "open");
        }
        for checkpoint in checkpoints {
            history.push(json!({"work_id":id,"revision":checkpoint["revision"],"stage":checkpoint["stage"],"summary":checkpoint["public_summary"],"created_at":checkpoint["created_at"]}));
        }
        all_actions.extend(actions(db, id)?);
        result["disposition"] = latest(db, Query::Disposition, id)?
            .map(|d| d["disposition"].clone())
            .unwrap_or(Value::Null);
    }
    result["counts"] = json!({"completed":all_actions.iter().filter(|a| a["status"] == "done").count(),"total":all_actions.len()});
    result["actions"] = json!(all_actions);
    result["stage_history"] = json!(history);
    Ok(result)
}

/// Adds derived card data on the same read snapshot as the canon response.
pub fn enrich(db: &Connection, value: &mut Value) -> Result<()> {
    if let Some(items) = value.as_array_mut() {
        for item in items {
            enrich(db, item)?;
        }
    } else if let Some(object) = value.as_object_mut() {
        if object.contains_key("canon_status") {
            let id = object
                .get("id")
                .and_then(Value::as_str)
                .ok_or(Error::Invalid("epic id"))?;
            let progress = progress(db, id)?;
            object.insert("task_counts".into(), progress["counts"].clone());
            object.insert("running".into(), progress["running"].clone());
        }
        for key in ["backlog", "plans", "works", "groups", "rows", "work"] {
            if let Some(child) = object.get_mut(key) {
                enrich(db, child)?;
            }
        }
    }
    Ok(())
}

pub(super) fn reported(db: &Connection, work: &str) -> Result<bool> {
    let Some(disposition) = latest(db, Query::Disposition, work)? else {
        return Ok(false);
    };
    if disposition["disposition"] != "completed" {
        return Ok(false);
    }
    let Some(review) = latest(db, Query::Review, work)? else {
        return Ok(false);
    };
    if review["subject"] != "completion" || review["verdict"] != "accept" {
        return Ok(false);
    }
    let checkpoints = rows(db, Query::Checkpoints.sql(), [work])?;
    let Some(checkpoint) = checkpoints.last() else {
        return Ok(false);
    };
    if checkpoint["stage"] != "reporting" {
        return Ok(false);
    }
    let finished = |turn: &str| -> Result<bool> {
        let state: Option<String> = db
            .query_row(Query::Turn.sql(), [turn], |r| r.get(0))
            .optional()?;
        Ok(state.as_deref() == Some("delivered"))
    };
    Ok(finished(text(checkpoint, "origin_turn_id")?)?
        && finished(text(&disposition, "origin_turn_id")?)?)
}
