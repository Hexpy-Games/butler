//! Completion obligations include explicit decomposed coverage and parent integration.
use super::*;
use std::collections::{HashMap, HashSet, VecDeque};
type Key = (String, String);

pub(super) fn complete(
    db: &Connection,
    scope: &str,
    plan: &reads::Plan,
    work: Option<&str>,
) -> Result<()> {
    let (criteria, direct) = criteria(db, scope, &plan.id)?;
    let mut groups = HashMap::<Key, (bool, Vec<Key>)>::new();
    let mut statement=db.prepare_cached("SELECT node_id,criterion_id,child_node_id,child_criterion_id,semantics FROM wm_coverage WHERE scope_id=?1 AND plan_id=?2").map_err(sql)?;
    let rows = statement
        .query_map(params![scope, plan.id], |r| {
            Ok((
                (r.get::<_, String>(0)?, r.get::<_, String>(1)?),
                (r.get::<_, String>(2)?, r.get::<_, String>(3)?),
                r.get::<_, String>(4)?,
            ))
        })
        .map_err(sql)?;
    for row in rows {
        let (parent, child, mode) = row.map_err(sql)?;
        groups
            .entry(parent)
            .or_insert_with(|| (mode == "any", vec![]))
            .1
            .push(child);
    }
    let verified = derive(&criteria, direct, &groups)?;
    let obligations = if let Some(id) = work {
        let binding: String = db
            .query_row(
                "SELECT binding_json FROM wm_works WHERE scope_id=?1 AND plan_id=?2 AND id=?3",
                params![scope, plan.id, id],
                |r| r.get(0),
            )
            .optional()
            .map_err(sql)?
            .ok_or_else(|| error("work_scope_invalid"))?;
        let binding: WorkDraft = decode(&binding)?;
        binding
            .criterion_ids
            .into_iter()
            .map(|c| (binding.node_id.clone(), c))
            .collect::<HashSet<_>>()
    } else {
        criteria
    };
    check(
        obligations.is_subset(&verified),
        "criterion_coverage_incomplete",
    )
}
fn criteria(db: &Connection, scope: &str, plan: &str) -> Result<(HashSet<Key>, HashSet<Key>)> {
    let mut statement=db.prepare_cached("SELECT c.node_id,c.criterion_id,EXISTS(SELECT 1 FROM wm_task_criteria a JOIN wm_tasks t ON t.scope_id=a.scope_id AND t.plan_id=a.plan_id AND t.id=a.task_id WHERE a.scope_id=c.scope_id AND a.plan_id=n.plan_id AND a.node_id=c.node_id AND a.node_revision=c.node_revision AND a.criterion_id=c.criterion_id AND t.status='completed') FROM wm_tree n JOIN wm_criteria c ON c.scope_id=n.scope_id AND c.node_id=n.node_id AND c.node_revision=n.node_revision WHERE n.scope_id=?1 AND n.plan_id=?2").map_err(sql)?;
    let mut criteria = HashSet::new();
    let mut verified = HashSet::new();
    for row in statement
        .query_map(params![scope, plan], |r| {
            Ok((
                (r.get::<_, String>(0)?, r.get::<_, String>(1)?),
                r.get::<_, bool>(2)?,
            ))
        })
        .map_err(sql)?
    {
        let (key, passed) = row.map_err(sql)?;
        criteria.insert(key.clone());
        if passed {
            verified.insert(key);
        }
    }
    Ok((criteria, verified))
}
fn derive(
    criteria: &HashSet<Key>,
    mut verified: HashSet<Key>,
    groups: &HashMap<Key, (bool, Vec<Key>)>,
) -> Result<HashSet<Key>> {
    let mut degrees = criteria
        .iter()
        .map(|k| (k.clone(), groups.get(k).map_or(0, |g| g.1.len())))
        .collect::<HashMap<_, _>>();
    let mut parents = HashMap::<Key, Vec<Key>>::new();
    for (parent, (_, children)) in groups {
        for child in children {
            parents
                .entry(child.clone())
                .or_default()
                .push(parent.clone());
        }
    }
    let mut ready = degrees
        .iter()
        .filter(|(_, n)| **n == 0)
        .map(|(k, _)| k.clone())
        .collect::<VecDeque<_>>();
    let mut visited = 0;
    while let Some(key) = ready.pop_front() {
        visited += 1;
        if let Some((any, children)) = groups.get(&key) {
            let pass = if *any {
                children.iter().any(|c| verified.contains(c))
            } else {
                children.iter().all(|c| verified.contains(c))
            };
            if pass {
                verified.insert(key.clone());
            } else {
                // A direct review cannot bypass explicit decomposed obligations.
                verified.remove(&key);
            }
        }
        for parent in parents.get(&key).into_iter().flatten() {
            let degree = degrees
                .get_mut(parent)
                .ok_or_else(|| error("coverage_integrity_error"))?;
            *degree -= 1;
            if *degree == 0 {
                ready.push_back(parent.clone());
            }
        }
    }
    check(visited == criteria.len(), "coverage_integrity_error")?;
    Ok(verified)
}
