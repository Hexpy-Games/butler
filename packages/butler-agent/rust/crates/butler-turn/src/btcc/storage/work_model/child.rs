use super::*;
/// Called inside the subsession transaction: assignment and dispatch intent
/// share one commit, and the child's root is the existing canonical Work.
pub(in crate::btcc::storage) fn assign_child(
    db: &Connection,
    input: &crate::btcc::SubsessionCreate,
) -> Result<()> {
    let enabled: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='wm_mode')",
            [],
            |r| r.get(0),
        )
        .map_err(sql)?;
    if !enabled {
        return Ok(());
    }
    let plan = reads::require_plan(db, &input.parent_session_id)?;
    check(plan.tier == 2, "tier_two_required")?;
    let before = tasks::load(db, &plan.scope_id, &plan.id, &input.packet.task_id)?;
    check(
        before.status == "running"
            && before.assignee_session_id.as_deref() == Some(&input.parent_session_id),
        "task_assignment_conflict",
    )?;
    check(
        input.parent_session_id == plan.owner_session_id || before.allow_nested_delegation,
        "nested_delegation_grant_required",
    )?;
    let mut task = before.clone();
    task.status = "pending".into();
    task.revision += 1;
    task.assignee_session_id = Some(input.child_session_id.clone());
    tasks::save(db, &plan.scope_id, &plan.id, &before, &mut task)?;
    db.execute("UPDATE wm_attempts SET status='interrupted' WHERE scope_id=?1 AND plan_id=?2 AND task_id=?3 AND status='running'", params![plan.scope_id,plan.id,task.id]).map_err(sql)?;
    db.execute(
        "UPDATE wm_sessions SET current_task_id=NULL WHERE session_id=?1 AND current_task_id=?2",
        params![input.parent_session_id, task.id],
    )
    .map_err(sql)?;
    db.execute("INSERT INTO wm_sessions(session_id,scope_id,plan_id,current_task_id,routing_reason) VALUES(?1,?2,?3,?4,'delegation')", params![input.child_session_id,plan.scope_id,plan.id,task.id]).map_err(sql)?;
    record_assignment(db, input, &plan, &task)?;
    Ok(())
}

fn record_assignment(
    db: &Connection,
    input: &crate::btcc::SubsessionCreate,
    plan: &reads::Plan,
    task: &TaskCard,
) -> Result<()> {
    let request = json!({"op":"assign","task_id":task.id,"child_session_id":input.child_session_id,"relation_id":input.relation_id});
    let receipt = json!({"ok":true,"task_id":task.id,"revision":task.revision});
    db.execute("INSERT INTO wm_audit(scope_id,plan_id,session_id,instruction_id,operation_key,payload_hash,request_json,result_json,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![plan.scope_id,plan.id,input.parent_session_id,input.parent_turn_id,input.delegation_id,fingerprint(&request)?,encode(&request)?,encode(&receipt)?,input.created_at]).map_err(sql)?;
    let seq = db.last_insert_rowid();
    db.execute(
        "UPDATE wm_plans SET event_seq=?1,revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE scope_id=?2 AND id=?3",
        params![seq, plan.scope_id, plan.id],
    )
    .map_err(sql)?;
    db.execute("INSERT INTO wm_outbox VALUES(?1,?2)",params![seq,encode(&json!({"kind":"work_model.changed","event_seq":seq,"plan_id":plan.id,"tier":plan.tier,"graph_revision":plan.graph_revision,"task_id":task.id,"revision":task.revision}))?]).map_err(sql)?;
    Ok(())
}

pub(super) fn is_parent(db: &Connection, session: &str, task: &TaskCard) -> Result<bool> {
    let Some(child) = task.assignee_session_id.as_deref() else {
        return Ok(false);
    };
    db.query_row("SELECT EXISTS(SELECT 1 FROM btcc_session_relations r JOIN btcc_subsession_delegations d ON d.relation_id=r.relation_id WHERE r.parent_session_id=?1 AND r.child_session_id=?2 AND json_extract(d.packet_json,'$.task_id')=?3)",params![session,child,task.id],|r|r.get(0)).map_err(sql)
}
pub(super) fn authorize(
    db: &Connection,
    session: &str,
    plan: &reads::Plan,
    command: &WorkModelCommand,
) -> Result<()> {
    if session == plan.owner_session_id {
        return Ok(());
    }
    match command {
        WorkModelCommand::Start { task_id, .. } | WorkModelCommand::Submit { task_id, .. } => {
            let current: Option<String> = db
                .query_row(
                    "SELECT current_task_id FROM wm_sessions WHERE session_id=?1",
                    [session],
                    |r| r.get(0),
                )
                .map_err(sql)?;
            check(
                current.as_ref() == Some(task_id),
                "task_mutation_scope_invalid",
            )
        }
        WorkModelCommand::Review { task_id, .. } | WorkModelCommand::Complete { task_id, .. } => {
            let task = tasks::load(db, &plan.scope_id, &plan.id, task_id)?;
            check(
                is_parent(db, session, &task)?,
                "task_mutation_scope_invalid",
            )
        }
        _ => Err(error("task_mutation_scope_invalid")),
    }
}
