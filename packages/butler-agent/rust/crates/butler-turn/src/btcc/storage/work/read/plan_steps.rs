//! Accepted plan history and action timing, bounded to one durable Work.
use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, params};
use serde_json::{Value, json};

use super::super::{StorageError, StorageResult, common};
use crate::btcc::work::{ActionProgress, ActionStatus, PlanAction, ReviewVerdict, WorkView};

#[derive(Default)]
struct Timing {
    active: Option<String>,
    non_pending: Option<String>,
    finished: Option<String>,
}

pub(in crate::btcc::storage::work) fn read(
    db: &Connection,
    work: &WorkView,
) -> StorageResult<Option<Value>> {
    let Some(plan) = &work.current_plan else {
        return Ok(None);
    };
    if !work.latest_plan_review.as_ref().is_some_and(|review| {
        review.verdict == ReviewVerdict::Accept
            && review.bound_plan_revision_id.as_deref() == Some(&plan.plan_revision_id)
    }) {
        return Ok(None);
    }
    let review_revision = work.latest_plan_review.as_ref().map_or(0, |r| r.revision);
    let (revisions, added) = revisions(db, &work.work_id, plan.revision, review_revision)?;
    let checkpoint_revision = work.latest_checkpoint.as_ref().map_or(0, |c| c.revision);
    let timing = timing(db, &work.work_id, checkpoint_revision)?;
    let actions = plan
        .actions
        .iter()
        .enumerate()
        .map(|(index, action)| {
            let status = work
                .action_progress
                .iter()
                .find(|p| p.action_key == action.action_key)
                .map_or(ActionStatus::Pending, |p| p.status);
            let mut value = json!({"action_key":action.action_key,"order":index + 1,
            "title":action.action_key,"purpose":action.description,"status":status,
            "added_in_revision":added.get(&action.action_key).copied().unwrap_or(plan.revision)});
            if let Some(t) = timing.get(&action.action_key)
                && let Some(fields) = value.as_object_mut()
            {
                if let Some(at) = t.active.as_ref().or(t.non_pending.as_ref()) {
                    fields.insert("started_at".into(), json!(at));
                }
                if matches!(
                    status,
                    ActionStatus::Done | ActionStatus::Skipped | ActionStatus::Blocked
                ) && let Some(at) = &t.finished
                {
                    fields.insert("finished_at".into(), json!(at));
                }
            }
            value
        })
        .collect::<Vec<_>>();
    Ok(Some(
        json!({"revision":plan.revision,"actions":actions,"revisions":revisions}),
    ))
}

fn revisions(
    db: &Connection,
    work: &str,
    plan_revision: u64,
    review_revision: u64,
) -> StorageResult<(Vec<Value>, HashMap<String, u64>)> {
    // Both histories use their UNIQUE(work_id, revision) indexes. Collect accepted ids
    // once instead of probing all reviews separately for every plan revision.
    let mut statement = db.prepare("SELECT bound_plan_revision_id FROM btcc_guided_work_review_revisions WHERE work_id=?1 AND revision<=?2 AND subject='plan' AND verdict='accept' ORDER BY revision").map_err(StorageError::sqlite)?;
    let accepted = statement
        .query_map(params![work, review_revision], |r| r.get::<_, String>(0))
        .map_err(StorageError::sqlite)?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(StorageError::sqlite)?;
    let mut statement = db.prepare("SELECT plan_revision_id,revision,created_at,actions_json FROM btcc_guided_work_plan_revisions WHERE work_id=?1 AND revision<=?2 ORDER BY revision").map_err(StorageError::sqlite)?;
    let rows = statement
        .query_map(params![work, plan_revision], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, u64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .map_err(StorageError::sqlite)?;
    let mut previous: Option<Vec<String>> = None;
    let mut first = HashMap::new();
    let mut revisions = Vec::new();
    for row in rows {
        let (id, revision, at, raw) = row.map_err(StorageError::sqlite)?;
        if !accepted.contains(&id) {
            continue;
        }
        let actions: Vec<PlanAction> = common::parse_json(&raw)?;
        let keys = actions
            .into_iter()
            .map(|a| a.action_key)
            .collect::<Vec<_>>();
        for key in &keys {
            first.entry(key.clone()).or_insert(revision);
        }
        if let Some(prior) = previous {
            let old: HashSet<_> = prior.iter().collect();
            let new: HashSet<_> = keys.iter().collect();
            revisions.push(json!({"revision":revision,"at":at,
                "added":keys.iter().filter(|k| !old.contains(k)).collect::<Vec<_>>(),
                "removed":prior.iter().filter(|k| !new.contains(k)).collect::<Vec<_>>() }));
        }
        previous = Some(keys);
    }
    Ok((revisions, first))
}

fn timing(db: &Connection, work: &str, revision: u64) -> StorageResult<HashMap<String, Timing>> {
    let mut statement = db.prepare("SELECT action_states_json,created_at FROM btcc_guided_work_checkpoint_revisions WHERE work_id=?1 AND revision<=?2 ORDER BY revision").map_err(StorageError::sqlite)?;
    let rows = statement
        .query_map(params![work, revision], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(StorageError::sqlite)?;
    let mut result: HashMap<String, Timing> = HashMap::new();
    for row in rows {
        let (raw, at) = row.map_err(StorageError::sqlite)?;
        let actions: Vec<ActionProgress> = common::parse_json(&raw)?;
        for action in actions {
            let t = result.entry(action.action_key).or_default();
            if action.status != ActionStatus::Pending {
                t.non_pending.get_or_insert_with(|| at.clone());
            }
            if action.status == ActionStatus::Active {
                t.active.get_or_insert_with(|| at.clone());
            }
            match action.status {
                ActionStatus::Pending | ActionStatus::Active => t.finished = None,
                _ => {
                    t.finished.get_or_insert_with(|| at.clone());
                }
            }
        }
    }
    Ok(result)
}
