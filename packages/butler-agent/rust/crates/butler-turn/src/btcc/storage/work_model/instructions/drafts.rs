use super::*;

pub(super) fn placeholder(
    db: &Connection,
    session: &str,
    id: &str,
    anchor: Option<&str>,
    input: &InstructionInput,
    receipt: &mut Value,
) -> Result<()> {
    let plan = reads::require_plan(db, session)?;
    let anchor = tasks::load(
        db,
        &plan.scope_id,
        &plan.id,
        anchor.ok_or_else(|| error("task_anchor_required"))?,
    )?;
    let InstructionBody::Text(body) = &input.instruction else {
        return Ok(());
    };
    let mut card = anchor.clone();
    card.id = stable_id("TASK", &plan.id, id)?;
    card.title = body.text.clone();
    card.description = body.text.clone();
    card.origin_instruction_id = id.into();
    card.author = "instruction".into();
    card.created_at = chrono::Utc::now().to_rfc3339();
    card.updated_at = card.created_at.clone();
    card.status = "draft".into();
    card.criterion_ids.clear();
    card.result_refs.clear();
    card.evidence_refs.clear();
    card.review_id = None;
    card.result_revision = 0;
    card.revision = 1;
    card.assignee_session_id = Some(session.into());
    card.allow_nested_delegation = false;
    card.blocked_reason = Some("instruction_criterion_mapping_unresolved".into());
    card.rank = db.query_row("SELECT rank+1 FROM wm_tasks WHERE scope_id=?1 AND plan_id=?2 ORDER BY rank DESC LIMIT 1",params![plan.scope_id,plan.id],|r|r.get(0)).map_err(sql)?;
    db.execute(
        "INSERT INTO wm_tasks VALUES(?1,?2,?3,?4,?5,?6,?7,'draft',1,?8)",
        params![
            plan.scope_id,
            plan.id,
            card.work_id,
            card.id,
            card.spec_ref.node_id,
            card.spec_ref.node_revision,
            card.rank,
            encode(&card)?
        ],
    )
    .map_err(sql)?;
    db.execute(
        "INSERT INTO wm_edges VALUES(?1,?2,?3,?4,?5)",
        params![plan.scope_id, plan.id, anchor.id, card.id, id],
    )
    .map_err(sql)?;
    db.execute("INSERT INTO wm_counts VALUES(?1,?2,'draft',1) ON CONFLICT(scope_id,plan_id,status) DO UPDATE SET total=total+1",params![plan.scope_id,plan.id]).map_err(sql)?;
    db.execute("UPDATE wm_plans SET task_count=task_count+1,edge_count=edge_count+1,graph_revision=graph_revision+1 WHERE scope_id=?1 AND id=?2",params![plan.scope_id,plan.id]).map_err(sql)?;
    db.execute(
        "UPDATE wm_instructions SET draft_task_id=?1 WHERE id=?2",
        params![card.id, id],
    )
    .map_err(sql)?;
    set(receipt, "draft_task_id", json!(card.id))?;
    set(receipt, "graph_revision", json!(plan.graph_revision + 1))?;
    Ok(())
}

pub(in crate::btcc::storage::work_model) fn resolve(
    db: &Connection,
    session: &str,
    plan: &reads::Plan,
    task: &mut TaskCard,
    criteria: &[String],
    question: bool,
) -> Result<()> {
    check(task.status == "draft", "instruction_draft_required")?;
    let eligible: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM wm_instructions WHERE id=?1 AND session_id=?2 AND draft_task_id=?3 AND status IN ('delivered','needs_input'))",params![task.origin_instruction_id,session,task.id],|r|r.get(0)).map_err(sql)?;
    check(eligible, "instruction_not_delivered")?;
    check(
        question || !criteria.is_empty(),
        "criterion_binding_required",
    )?;
    check(
        !question || criteria.is_empty(),
        "question_has_task_criteria",
    )?;
    let total: u64 = db.query_row("SELECT sum(total) FROM wm_counts WHERE scope_id=?1 AND plan_id=?2 AND status<>'cancelled'",params![plan.scope_id,plan.id],|r|r.get(0)).map_err(sql)?;
    check(
        question || plan.tier == 2 || total <= 5,
        "in_use_spec_replan_unavailable",
    )?;
    let mut unique = std::collections::HashSet::new();
    for criterion in criteria {
        check(unique.insert(criterion), "criterion_binding_invalid")?;
        let exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM wm_criteria WHERE scope_id=?1 AND node_id=?2 AND node_revision=?3 AND criterion_id=?4 AND part_id IN (SELECT value FROM json_each(?5)))",params![plan.scope_id,task.spec_ref.node_id,task.spec_ref.node_revision,criterion,encode(&task.part_ids)?],|r|r.get(0)).map_err(sql)?;
        check(exists, "in_use_spec_replan_unavailable")?;
        db.execute(
            "INSERT INTO wm_task_criteria VALUES(?1,?2,?3,?4,?5,?6)",
            params![
                plan.scope_id,
                plan.id,
                task.id,
                task.spec_ref.node_id,
                task.spec_ref.node_revision,
                criterion
            ],
        )
        .map_err(sql)?;
    }
    task.criterion_ids = criteria.to_vec();
    task.status = if question { "cancelled" } else { "pending" }.into();
    task.blocked_reason = question.then(|| "instruction_resolved_as_question_or_control".into());
    let prior: String = db
        .query_row(
            "SELECT receipt_json FROM wm_instructions WHERE id=?1",
            [&task.origin_instruction_id],
            |r| r.get(0),
        )
        .map_err(sql)?;
    let mut receipt: Value = decode(&prior)?;
    set(&mut receipt, "status", json!("applied"))?;
    set(&mut receipt, "resolved_task_id", json!(task.id))?;
    set(
        &mut receipt,
        "resolution",
        json!(if question { "question" } else { "task" }),
    )?;
    event(db, session, &task.origin_instruction_id, &mut receipt)?;
    graph::advance(db, &plan.scope_id, &plan.id)
}

pub(super) fn cancel(
    db: &Connection,
    session: &str,
    receipt: &mut Value,
    reason: &str,
) -> Result<()> {
    let Some(id) = receipt
        .get("draft_task_id")
        .unwrap_or(&Value::Null)
        .as_str()
    else {
        return Ok(());
    };
    let plan = reads::require_plan(db, session)?;
    let before = tasks::load(db, &plan.scope_id, &plan.id, id)?;
    if before.status != "draft" {
        return Ok(());
    }
    let mut task = before.clone();
    task.status = "cancelled".into();
    task.revision += 1;
    task.blocked_reason = Some(reason.into());
    tasks::save(db, &plan.scope_id, &plan.id, &before, &mut task)?;
    let removed = db
        .execute(
            "DELETE FROM wm_edges WHERE scope_id=?1 AND plan_id=?2 AND successor=?3",
            params![plan.scope_id, plan.id, id],
        )
        .map_err(sql)?;
    db.execute(
        "UPDATE wm_plans SET edge_count=edge_count-?3 WHERE scope_id=?1 AND id=?2",
        params![plan.scope_id, plan.id, removed],
    )
    .map_err(sql)?;
    graph::advance(db, &plan.scope_id, &plan.id)?;
    set(
        receipt,
        "draft_resolution",
        json!({"task_id":id,"status":"cancelled","reason":reason}),
    )?;
    Ok(())
}

pub(in crate::btcc::storage::work_model) fn unresolved(
    db: &Connection,
    session: &str,
    request: &WorkModelRequest,
    failure: &Value,
) -> Result<()> {
    if failure
        .get("error")
        .and_then(|e| e.get("code"))
        .and_then(Value::as_str)
        != Some("in_use_spec_replan_unavailable")
    {
        return Ok(());
    }
    let commands = match &request.command {
        WorkModelCommand::Batch { operations, .. } => operations.as_slice(),
        command => std::slice::from_ref(command),
    };
    for command in commands {
        if let WorkModelCommand::ResolveDraft { task_id, .. } = command {
            let prior: Option<(String,String)> = db.query_row("SELECT id,receipt_json FROM wm_instructions WHERE session_id=?1 AND draft_task_id=?2 AND status IN ('delivered','needs_input')",params![session,task_id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(sql)?;
            if let Some((id, prior)) = prior {
                let mut receipt: Value = decode(&prior)?;
                set(&mut receipt, "status", json!("needs_input"))?;
                set(
                    &mut receipt,
                    "error",
                    failure.get("error").cloned().unwrap_or(Value::Null),
                )?;
                event(db, session, &id, &mut receipt)?;
            }
        }
    }
    Ok(())
}
