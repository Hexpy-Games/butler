use super::*;
use std::collections::HashSet;

pub(super) fn apply(
    db: &Connection,
    scope: &str,
    plan: &reads::Plan,
    request: &WorkModelRequest,
) -> Result<Value> {
    match &request.command {
        WorkModelCommand::Reorder { task_ids } => reorder(db, scope, plan, task_ids)?,
        WorkModelCommand::Dependencies { add, remove } => {
            dependencies(db, scope, plan, &request.idempotency_key, add, remove)?;
        }
        WorkModelCommand::Step { task_id, phase } => {
            check(
                [
                    "conception",
                    "planning",
                    "execution",
                    "review",
                    "validation",
                    "reporting",
                ]
                .contains(&phase.as_str()),
                "phase_invalid",
            )?;
            let task = tasks::load(db, scope, &plan.id, task_id)?;
            tasks::ready(db, scope, &plan.id, &task)?;
            let current: Option<String> = db
                .query_row(
                    "SELECT current_task_id FROM wm_sessions WHERE session_id=?1",
                    [scope],
                    |r| r.get(0),
                )
                .map_err(sql)?;
            check(current.is_none(), "current_task_unsettled")?;
            db.execute(
                "UPDATE wm_sessions SET selected_task_id=?1 WHERE session_id=?2",
                params![task.id, scope],
            )
            .map_err(sql)?;
            db.execute(
                "UPDATE wm_plans SET phase=?1 WHERE scope_id=?2 AND id=?3",
                params![phase, scope, plan.id],
            )
            .map_err(sql)?;
        }
        _ => return Err(error("work_model_operation_unavailable")),
    }
    advance(db, scope, &plan.id)?;
    Ok(json!({"ok":true,"graph_revision":plan.graph_revision+1}))
}

pub(super) fn advance(db: &Connection, scope: &str, plan: &str) -> Result<()> {
    db.execute(
        "UPDATE wm_plans SET graph_revision=graph_revision+1 WHERE scope_id=?1 AND id=?2",
        params![scope, plan],
    )
    .map_err(sql)?;
    Ok(())
}

fn reorder(db: &Connection, scope: &str, plan: &reads::Plan, ids: &[String]) -> Result<()> {
    check(
        ids.iter().collect::<HashSet<_>>().len() == ids.len(),
        "task_order_duplicate",
    )?;
    let mut cards = ids
        .iter()
        .map(|id| tasks::load(db, scope, &plan.id, id))
        .collect::<Result<Vec<_>>>()?;
    check(
        cards.iter().all(|t| t.status == "pending")
            && cards
                .iter()
                .all(|t| Some(&t.work_id) == cards.first().map(|f| &f.work_id)),
        "task_order_invalid",
    )?;
    let mut ranks: Vec<_> = cards.iter().map(|t| t.rank).collect();
    ranks.sort_unstable();
    for (card, rank) in cards.iter_mut().zip(ranks) {
        let before = card.clone();
        card.rank = rank;
        card.revision += 1;
        tasks::save(db, scope, &plan.id, &before, card)?;
    }
    Ok(())
}

fn dependencies(
    db: &Connection,
    scope: &str,
    plan: &reads::Plan,
    operation: &str,
    add: &[Edge],
    remove: &[Edge],
) -> Result<()> {
    for edge in add.iter().chain(remove) {
        tasks::load(db, scope, &plan.id, &edge.from)?;
        let target = tasks::load(db, scope, &plan.id, &edge.to)?;
        check(target.status == "pending", "dependency_target_immutable")?;
    }
    for edge in remove {
        let changed = db.execute("DELETE FROM wm_edges WHERE scope_id=?1 AND plan_id=?2 AND predecessor=?3 AND successor=?4", params![scope,plan.id,edge.from,edge.to]).map_err(sql)?;
        check(changed == 1, "dependency_invalid")?;
    }
    for edge in add {
        let exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM wm_edges WHERE scope_id=?1 AND plan_id=?2 AND predecessor=?3 AND successor=?4)", params![scope,plan.id,edge.from,edge.to], |r| r.get(0)).map_err(sql)?;
        check(!exists, "dependency_duplicate")?;
        db.execute(
            "INSERT INTO wm_edges VALUES(?1,?2,?3,?4,?5)",
            params![scope, plan.id, edge.from, edge.to, operation],
        )
        .map_err(sql)?;
    }
    for edge in add {
        let cycle:bool=db.query_row("WITH RECURSIVE downstream(id) AS (SELECT ?4 UNION SELECT e.successor FROM downstream n CROSS JOIN wm_edges e ON e.scope_id=?1 AND e.plan_id=?2 AND e.predecessor=n.id) SELECT EXISTS(SELECT 1 FROM downstream WHERE id=?3)",params![scope,plan.id,edge.from,edge.to],|r|r.get(0)).map_err(sql)?;
        check(!cycle, "dependency_cycle")?;
    }
    let delta = i64::try_from(add.len()).map_err(|_| error("dependency_count_overflow"))?
        - i64::try_from(remove.len()).map_err(|_| error("dependency_count_overflow"))?;
    db.execute(
        "UPDATE wm_plans SET edge_count=edge_count+?3 WHERE scope_id=?1 AND id=?2",
        params![scope, plan.id, delta],
    )
    .map_err(sql)?;
    Ok(())
}
