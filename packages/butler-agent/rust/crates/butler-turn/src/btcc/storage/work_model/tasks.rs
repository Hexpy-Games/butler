use super::*;

pub(super) fn load(db: &Connection, scope: &str, plan: &str, id: &str) -> Result<TaskCard> {
    let encoded: Option<String> = db
        .query_row(
            "SELECT card_json FROM wm_tasks WHERE scope_id=?1 AND plan_id=?2 AND id=?3",
            params![scope, plan, id],
            |r| r.get(0),
        )
        .optional()
        .map_err(sql)?;
    decode(&encoded.ok_or_else(|| error("task_scope_invalid"))?)
}

pub(super) fn save(
    db: &Connection,
    scope: &str,
    plan: &str,
    before: &TaskCard,
    after: &mut TaskCard,
) -> Result<()> {
    check(before.status != "completed", "completed_task_immutable")?;
    after.updated_at = chrono::Utc::now().to_rfc3339();
    let changed = db.execute("UPDATE wm_tasks SET status=?1,revision=?2,rank=?3,card_json=?4 WHERE scope_id=?5 AND plan_id=?6 AND id=?7 AND revision=?8",
        params![after.status,after.revision,after.rank,encode(after)?,scope,plan,after.id,before.revision]).map_err(sql)?;
    check(changed == 1, "task_revision_conflict")?;
    if before.status != after.status {
        db.execute(
            "UPDATE wm_counts SET total=total-1 WHERE scope_id=?1 AND plan_id=?2 AND status=?3",
            params![scope, plan, before.status],
        )
        .map_err(sql)?;
        db.execute("INSERT INTO wm_counts VALUES(?1,?2,?3,1) ON CONFLICT(scope_id,plan_id,status) DO UPDATE SET total=total+1", params![scope,plan,after.status]).map_err(sql)?;
    }
    Ok(())
}

pub(super) fn ready(db: &Connection, scope: &str, plan: &str, task: &TaskCard) -> Result<()> {
    check(task.status == "pending", "task_not_pending")?;
    let blocked: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM wm_edges e JOIN wm_tasks p ON p.scope_id=e.scope_id AND p.plan_id=e.plan_id AND p.id=e.predecessor WHERE e.scope_id=?1 AND e.plan_id=?2 AND e.successor=?3 AND p.status<>'completed')",
        params![scope,plan,task.id], |r| r.get(0)).map_err(sql)?;
    check(!blocked, "prerequisite_unmet")
}

pub(super) fn apply(
    db: &Connection,
    session: &str,
    plan: &reads::Plan,
    request: &WorkModelRequest,
) -> Result<Value> {
    let (id, expected) = target(&request.command)?;
    let before = load(db, &plan.scope_id, &plan.id, id)?;
    check(before.status != "completed", "completed_task_immutable")?;
    check(before.revision == expected, "task_revision_conflict")?;
    let mut task = before.clone();
    match &request.command {
        WorkModelCommand::Start { .. } => start(db, session, plan, request, &mut task)?,
        WorkModelCommand::Submit {
            result_refs,
            evidence_refs,
            ..
        } => submit(db, session, plan, &mut task, result_refs, evidence_refs)?,
        WorkModelCommand::Review {
            result_revision,
            criterion_results,
            ..
        } => review(
            db,
            session,
            plan,
            request,
            &mut task,
            *result_revision,
            criterion_results,
        )?,
        WorkModelCommand::Complete { .. } => complete(db, session, plan, &mut task)?,
        WorkModelCommand::Remove { remove_edges, .. } => {
            remove(db, &plan.scope_id, plan, &mut task, remove_edges)?;
        }
        command => amend(db, session, plan, command, &mut task)?,
    }
    task.revision += 1;
    save(db, &plan.scope_id, &plan.id, &before, &mut task)?;
    if matches!(task.status.as_str(), "completed" | "cancelled") {
        instructions::task_boundary(db, &task.id)?;
    }
    Ok(json!({"ok":true,"task":task,"graph_revision":plan.graph_revision}))
}

fn target(command: &WorkModelCommand) -> Result<(&str, u64)> {
    match command {
        WorkModelCommand::Start {
            task_id,
            expected_revision,
        }
        | WorkModelCommand::Submit {
            task_id,
            expected_revision,
            ..
        }
        | WorkModelCommand::Review {
            task_id,
            expected_revision,
            ..
        }
        | WorkModelCommand::Complete {
            task_id,
            expected_revision,
        }
        | WorkModelCommand::Remove {
            task_id,
            expected_revision,
            ..
        }
        | WorkModelCommand::ResolveDraft {
            task_id,
            expected_revision,
            ..
        }
        | WorkModelCommand::Edit {
            task_id,
            expected_revision,
            ..
        }
        | WorkModelCommand::Block {
            task_id,
            expected_revision,
            ..
        } => Ok((task_id.as_str(), *expected_revision)),
        _ => Err(error("work_model_operation_unavailable")),
    }
}

fn amend(
    db: &Connection,
    session: &str,
    plan: &reads::Plan,
    command: &WorkModelCommand,
    task: &mut TaskCard,
) -> Result<()> {
    match command {
        WorkModelCommand::ResolveDraft {
            criterion_ids,
            question,
            ..
        } => instructions::drafts::resolve(db, session, plan, task, criterion_ids, *question)?,
        WorkModelCommand::Edit { description, .. } => {
            check(task.status == "pending", "active_task_settlement_required")?;
            check(!description.trim().is_empty(), "task_description_required")?;
            task.description = description.clone();
            task.title = description.clone();
            graph::advance(db, &plan.scope_id, &plan.id)?;
        }
        WorkModelCommand::Block { reason, .. } => {
            check(!reason.trim().is_empty(), "blocked_reason_required")?;
            check(
                matches!(task.status.as_str(), "running" | "awaiting_review"),
                "task_not_running",
            )?;
            effects_settled(db, plan, task)?;
            task.status = "blocked".into();
            task.blocked_reason = Some(reason.clone());
            db.execute("UPDATE wm_attempts SET status='interrupted' WHERE scope_id=?1 AND plan_id=?2 AND task_id=?3 AND status='running'",params![plan.scope_id,plan.id,task.id]).map_err(sql)?;
        }
        _ => return Err(error("work_model_operation_unavailable")),
    }
    Ok(())
}

fn start(
    db: &Connection,
    session: &str,
    plan: &reads::Plan,
    request: &WorkModelRequest,
    task: &mut TaskCard,
) -> Result<()> {
    instructions::delivery::claim_gate(db, session)?;
    ready(db, &plan.scope_id, &plan.id, task)?;
    check(
        task.assignee_session_id
            .as_deref()
            .is_none_or(|assignee| assignee == session),
        "task_assignment_conflict",
    )?;
    let current: Option<String> = db
        .query_row(
            "SELECT current_task_id FROM wm_sessions WHERE session_id=?1",
            [session],
            |r| r.get(0),
        )
        .map_err(sql)?;
    check(
        current.is_none() || current.as_deref() == Some(&task.id),
        "current_task_unsettled",
    )?;
    let selected: Option<String> = db
        .query_row(
            "SELECT selected_task_id FROM wm_sessions WHERE session_id=?1",
            [session],
            |r| r.get(0),
        )
        .map_err(sql)?;
    check(
        selected.is_none() || selected.as_deref() == Some(&task.id),
        "selected_task_conflict",
    )?;
    let attempt = stable_id("ATTEMPT", &task.id, &request.idempotency_key)?;
    db.execute(
        "INSERT INTO wm_attempts VALUES(?1,?2,?3,?4,?5,?8,?6,?7,'running')",
        params![
            plan.scope_id,
            plan.id,
            attempt,
            task.id,
            task.revision,
            request.instruction_id,
            encode(&task.spec_ref)?,
            session
        ],
    )
    .map_err(sql)?;
    db.execute(
        "UPDATE wm_sessions SET current_task_id=?1 WHERE session_id=?2",
        params![task.id, session],
    )
    .map_err(sql)?;
    db.execute(
        "UPDATE wm_plans SET status='running' WHERE scope_id=?1 AND id=?2",
        params![plan.scope_id, plan.id],
    )
    .map_err(sql)?;
    db.execute(
        "UPDATE wm_works SET status='running',revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE scope_id=?1 AND plan_id=?2 AND id=?3 AND status='ready'",
        params![plan.scope_id, plan.id, task.work_id],
    )
    .map_err(sql)?;
    task.blocked_reason = None;
    task.status = "running".into();
    task.assignee_session_id = Some(session.into());
    Ok(())
}

fn submit(
    db: &Connection,
    session: &str,
    plan: &reads::Plan,
    task: &mut TaskCard,
    results: &[String],
    evidence: &[String],
) -> Result<()> {
    check(
        task.status == "running" && task.assignee_session_id.as_deref() == Some(session),
        "task_not_running",
    )?;
    effects_settled(db, plan, task)?;
    check(
        !results.is_empty()
            && !evidence.is_empty()
            && results.iter().chain(evidence).all(|r| !r.trim().is_empty()),
        "result_evidence_required",
    )?;
    task.result_revision += 1;
    task.result_refs = results.to_vec();
    task.evidence_refs = evidence.to_vec();
    task.review_id = None;
    task.status = "awaiting_review".into();
    db.execute(
        "INSERT INTO wm_results VALUES(?1,?2,?3,?4,?5)",
        params![
            plan.scope_id,
            plan.id,
            task.id,
            task.result_revision,
            encode(task)?
        ],
    )
    .map_err(sql)?;
    db.execute("UPDATE wm_attempts SET status='succeeded' WHERE scope_id=?1 AND plan_id=?2 AND task_id=?3 AND status='running'", params![plan.scope_id,plan.id,task.id]).map_err(sql)?;
    Ok(())
}

fn review(
    db: &Connection,
    session: &str,
    plan: &reads::Plan,
    request: &WorkModelRequest,
    task: &mut TaskCard,
    result_revision: u64,
    results: &[CriterionResult],
) -> Result<()> {
    check(task.status == "awaiting_review", "task_not_awaiting_review")?;
    check(
        task.result_revision == result_revision && result_revision > 0,
        "result_revision_conflict",
    )?;
    let independent: bool = db.query_row("SELECT independent_review FROM wm_specs WHERE scope_id=?1 AND node_id=?2 AND node_revision=?3",
        params![plan.scope_id,task.spec_ref.node_id,task.spec_ref.node_revision], |r| r.get(0)).map_err(sql)?;
    check(
        (session == plan.owner_session_id || child::is_parent(db, session, task)?)
            && (!independent || task.assignee_session_id.as_deref() != Some(session)),
        "independent_reviewer_required",
    )?;
    let unique: std::collections::HashSet<_> = results.iter().map(|r| &r.criterion_id).collect();
    check(
        unique.len() == results.len()
            && results.len() == task.criterion_ids.len()
            && task.criterion_ids.iter().all(|id| unique.contains(id)),
        "criterion_review_required",
    )?;
    check(
        results.iter().all(|r| {
            !r.reason.trim().is_empty()
                && !r.evidence_refs.is_empty()
                && r.evidence_refs
                    .iter()
                    .all(|e| task.evidence_refs.contains(e) || task.result_refs.contains(e))
        }),
        "review_evidence_invalid",
    )?;
    let accepted = results.iter().all(|r| r.verdict == Verdict::Pass);
    let review_id = stable_id("REVIEW", &task.id, &request.idempotency_key)?;
    db.execute(
        "INSERT INTO wm_reviews VALUES(?1,?2,?3,?4,?5,?6,?9,?7,?8)",
        params![
            plan.scope_id,
            plan.id,
            review_id,
            task.id,
            task.revision,
            result_revision,
            accepted,
            encode(&json!({"spec_ref":task.spec_ref,"criterion_results":results}))?,
            session
        ],
    )
    .map_err(sql)?;
    if accepted {
        task.review_id = Some(review_id);
    } else {
        task.status = "pending".into();
        task.blocked_reason = Some("criterion_review_rejected".into());
        db.execute("UPDATE wm_sessions SET current_task_id=NULL,selected_task_id=NULL WHERE session_id=?1 AND (current_task_id=?2 OR selected_task_id=?2)", params![session,task.id]).map_err(sql)?;
    }
    Ok(())
}

fn complete(
    db: &Connection,
    _session: &str,
    plan: &reads::Plan,
    task: &mut TaskCard,
) -> Result<()> {
    effects_settled(db, plan, task)?;
    check(task.status == "awaiting_review", "task_not_awaiting_review")?;
    let id = task
        .review_id
        .as_ref()
        .ok_or_else(|| error("criterion_review_required"))?;
    let accepted: bool = db.query_row("SELECT accepted AND result_revision=?1 AND task_revision+1=?2 FROM wm_reviews WHERE scope_id=?3 AND plan_id=?4 AND id=?5 AND task_id=?6",
        params![task.result_revision,task.revision,plan.scope_id,plan.id,id,task.id], |r| r.get(0)).map_err(sql)?;
    check(accepted, "criterion_review_required")?;
    task.status = "completed".into();
    db.execute(
        "UPDATE wm_sessions SET current_task_id=NULL,selected_task_id=NULL WHERE current_task_id=?1 OR selected_task_id=?1",
        [&task.id],
    )
    .map_err(sql)?;
    Ok(())
}

fn effects_settled(db: &Connection, plan: &reads::Plan, task: &TaskCard) -> Result<()> {
    let prefix = format!("{}:{}:{}:", plan.id, plan.tree_version, task.id);
    let pending:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM btcc_guided_effects WHERE work_id=?1 AND plan_revision_id>=?2 AND plan_revision_id<?3 AND status IN('prepared','dispatching','uncertain'))",params![task.work_id,prefix,format!("{prefix}~")],|r|r.get(0)).map_err(sql)?;
    check(!pending, "task_effect_unsettled")
}

fn remove(
    db: &Connection,
    scope: &str,
    plan: &reads::Plan,
    task: &mut TaskCard,
    edges: &[Edge],
) -> Result<()> {
    check(task.status == "pending", "active_task_settlement_required")?;
    for edge in edges {
        check(
            edge.from == task.id || edge.to == task.id,
            "successor_edge_changes_invalid",
        )?;
        let changed=db.execute("DELETE FROM wm_edges WHERE scope_id=?1 AND plan_id=?2 AND predecessor=?3 AND successor=?4", params![scope,plan.id,edge.from,edge.to]).map_err(sql)?;
        check(changed == 1, "dependency_invalid")?;
        db.execute(
            "UPDATE wm_plans SET edge_count=edge_count-1 WHERE scope_id=?1 AND id=?2",
            params![scope, plan.id],
        )
        .map_err(sql)?;
    }
    let successors: u64 = db
        .query_row(
            "SELECT count(*) FROM wm_edges WHERE scope_id=?1 AND plan_id=?2 AND predecessor=?3",
            params![scope, plan.id, task.id],
            |r| r.get(0),
        )
        .map_err(sql)?;
    check(successors == 0, "successor_rewiring_required")?;
    for criterion in &task.criterion_ids {
        let covered: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM wm_task_criteria c JOIN wm_tasks t ON t.scope_id=c.scope_id AND t.plan_id=c.plan_id AND t.id=c.task_id WHERE c.scope_id=?1 AND c.plan_id=?2 AND c.node_id=?3 AND c.criterion_id=?4 AND t.id<>?5 AND t.status<>'cancelled')",
            params![scope,plan.id,task.spec_ref.node_id,criterion,task.id], |r| r.get(0)).map_err(sql)?;
        check(covered, "criterion_coverage_required")?;
    }
    task.status = "cancelled".into();
    graph::advance(db, scope, &plan.id)?;
    Ok(())
}

pub(super) fn aggregate(
    db: &Connection,
    scope: &str,
    plan: &reads::Plan,
    command: &WorkModelCommand,
) -> Result<Value> {
    let work_id = match command {
        WorkModelCommand::CompleteWork { work_id } => Some(work_id.as_str()),
        _ => None,
    };
    let incomplete: u64 = db.query_row("SELECT count(*) FROM wm_tasks WHERE scope_id=?1 AND plan_id=?2 AND (?3 IS NULL OR work_id=?3) AND status NOT IN('completed','cancelled')",
        params![scope,plan.id,work_id], |r| r.get(0)).map_err(sql)?;
    check(incomplete == 0 && plan.task_count > 0, "tasks_incomplete")?;
    coverage::complete(db, scope, plan, work_id)?;
    if let Some(id) = work_id {
        let changed = db
            .execute(
                "UPDATE wm_works SET status='completed',revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE scope_id=?1 AND plan_id=?2 AND id=?3",
                params![scope, plan.id, id],
            )
            .map_err(sql)?;
        check(changed == 1, "work_scope_invalid")?;
    } else {
        let incomplete: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM wm_works WHERE scope_id=?1 AND plan_id=?2 AND status<>'completed')", params![scope,plan.id], |r| r.get(0)).map_err(sql)?;
        check(!incomplete, "works_incomplete")?;
        db.execute(
            "UPDATE wm_plans SET status='completed' WHERE scope_id=?1 AND id=?2",
            params![scope, plan.id],
        )
        .map_err(sql)?;
    }
    Ok(
        json!({"ok":true,"plan_id":plan.id,"graph_revision":plan.graph_revision,"status":"completed"}),
    )
}
