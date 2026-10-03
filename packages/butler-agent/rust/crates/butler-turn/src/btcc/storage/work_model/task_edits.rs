use super::*;

pub(super) fn add(
    db: &Connection,
    session: &str,
    plan: &reads::Plan,
    request: &WorkModelRequest,
    work: &str,
    reference: &SpecRef,
    draft: &TaskDraft,
) -> Result<Value> {
    validate(db, plan, work, reference, draft)?;
    let card = card(db, session, plan, request, work, reference, draft)?;
    db.execute(
        "INSERT INTO wm_tasks VALUES(?1,?2,?3,?4,?5,?6,?7,'pending',1,?8)",
        params![
            plan.scope_id,
            plan.id,
            work,
            card.id,
            reference.node_id,
            reference.node_revision,
            card.rank,
            encode(&card)?
        ],
    )
    .map_err(sql)?;
    for criterion in &draft.criterion_ids {
        let valid: bool=db.query_row("SELECT EXISTS(SELECT 1 FROM wm_criteria WHERE scope_id=?1 AND node_id=?2 AND node_revision=?3 AND criterion_id=?4 AND part_id IN (SELECT value FROM json_each(?5)))",params![plan.scope_id,reference.node_id,reference.node_revision,criterion,encode(&draft.part_ids)?],|r|r.get(0)).map_err(sql)?;
        check(valid, "criterion_binding_invalid")?;
        db.execute(
            "INSERT INTO wm_task_criteria VALUES(?1,?2,?3,?4,?5,?6)",
            params![
                plan.scope_id,
                plan.id,
                card.id,
                reference.node_id,
                reference.node_revision,
                criterion
            ],
        )
        .map_err(sql)?;
    }
    for predecessor in &draft.after {
        let parent = tasks::load(db, &plan.scope_id, &plan.id, predecessor)?;
        check(parent.status != "cancelled", "dependency_invalid")?;
        db.execute(
            "INSERT INTO wm_edges VALUES(?1,?2,?3,?4,?5)",
            params![
                plan.scope_id,
                plan.id,
                predecessor,
                card.id,
                request.idempotency_key
            ],
        )
        .map_err(sql)?;
    }
    db.execute("INSERT INTO wm_counts VALUES(?1,?2,'pending',1) ON CONFLICT(scope_id,plan_id,status) DO UPDATE SET total=total+1",params![plan.scope_id,plan.id]).map_err(sql)?;
    db.execute("UPDATE wm_plans SET task_count=task_count+1,edge_count=edge_count+?3 WHERE scope_id=?1 AND id=?2",params![plan.scope_id,plan.id,draft.after.len()]).map_err(sql)?;
    graph::advance(db, &plan.scope_id, &plan.id)?;
    Ok(json!({"ok":true,"task":card,"graph_revision":plan.graph_revision+1}))
}

fn validate(
    db: &Connection,
    plan: &reads::Plan,
    work: &str,
    reference: &SpecRef,
    draft: &TaskDraft,
) -> Result<()> {
    check(
        !draft.description.trim().is_empty() && !draft.key.trim().is_empty(),
        "task_description_required",
    )?;
    let total: u64 = db.query_row("SELECT sum(total) FROM wm_counts WHERE scope_id=?1 AND plan_id=?2 AND status<>'cancelled'",params![plan.scope_id,plan.id],|r|r.get(0)).map_err(sql)?;
    check(
        plan.tier == 2 || total < 5,
        "in_use_spec_replan_unavailable",
    )?;
    let verified: Option<String> = db.query_row("SELECT s.reference_json FROM wm_tree t JOIN wm_specs s USING(scope_id,node_id,node_revision) WHERE t.scope_id=?1 AND t.plan_id=?2 AND t.node_id=?3",params![plan.scope_id,plan.id,reference.node_id],|r|r.get(0)).optional().map_err(sql)?;
    check(
        verified
            .map(|s| decode::<SpecRef>(&s))
            .transpose()?
            .as_ref()
            == Some(reference),
        "spec_integrity_error",
    )?;
    let valid_work: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM wm_works WHERE scope_id=?1 AND plan_id=?2 AND id=?3 AND status<>'completed')",params![plan.scope_id,plan.id,work],|r|r.get(0)).map_err(sql)?;
    check(valid_work, "work_scope_invalid")?;
    let work_node: String = db
        .query_row(
            "SELECT node_id FROM wm_works WHERE scope_id=?1 AND plan_id=?2 AND id=?3",
            params![plan.scope_id, plan.id, work],
            |r| r.get(0),
        )
        .map_err(sql)?;
    check(
        reads::ancestors(db, &plan.owner_session_id, &reference.node_id)?
            .iter()
            .any(|s| s.node_id == work_node),
        "work_spec_scope_invalid",
    )?;
    check(
        !draft.part_ids.is_empty() && !draft.criterion_ids.is_empty(),
        "criterion_binding_required",
    )?;
    for part in &draft.part_ids {
        let exists: bool=db.query_row("SELECT EXISTS(SELECT 1 FROM wm_parts WHERE scope_id=?1 AND node_id=?2 AND node_revision=?3 AND part_id=?4)",params![plan.scope_id,reference.node_id,reference.node_revision,part],|r|r.get(0)).map_err(sql)?;
        check(exists, "part_binding_invalid")?;
    }
    Ok(())
}

fn card(
    db: &Connection,
    session: &str,
    plan: &reads::Plan,
    request: &WorkModelRequest,
    work: &str,
    reference: &SpecRef,
    draft: &TaskDraft,
) -> Result<TaskCard> {
    let now = chrono::Utc::now().to_rfc3339();
    let rank: i64 = db
        .query_row(
            "SELECT COALESCE(MAX(rank),-1)+1 FROM wm_tasks WHERE scope_id=?1 AND plan_id=?2",
            params![plan.scope_id, plan.id],
            |r| r.get(0),
        )
        .map_err(sql)?;
    Ok(TaskCard {
        id: stable_id(
            "TASK",
            &plan.id,
            &format!("{}:{}", request.idempotency_key, draft.key),
        )?,
        scope: json!({"session_id":plan.scope_id}),
        title: draft.description.clone(),
        origin_instruction_id: request.instruction_id.clone(),
        author: session.into(),
        created_at: now.clone(),
        updated_at: now,
        work_id: work.into(),
        spec_ref: reference.clone(),
        description: draft.description.clone(),
        kind: draft.kind,
        allow_nested_delegation: draft.allow_nested_delegation,
        part_ids: draft.part_ids.clone(),
        criterion_ids: draft.criterion_ids.clone(),
        rank,
        status: "pending".into(),
        revision: 1,
        result_revision: 0,
        assignee_session_id: Some(session.into()),
        result_refs: vec![],
        evidence_refs: vec![],
        review_id: None,
        blocked_reason: None,
    })
}
