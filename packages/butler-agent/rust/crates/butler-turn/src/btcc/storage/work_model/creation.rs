use super::*;
use std::collections::HashMap;

pub(super) fn create(
    db: &Connection,
    session: &str,
    request: &WorkModelRequest,
    creation: &Creation,
) -> Result<Value> {
    check(
        reads::plan(db, session)?
            .is_none_or(|p| p.status == "completed" && p.owner_session_id == session),
        "in_use_spec_replan_unavailable",
    )?;
    let bundle = &creation.bundle;
    let plan_id = stable_id(
        "PLAN",
        session,
        &format!("{}:{}", request.instruction_id, request.idempotency_key),
    )?;
    let mut specs = HashMap::new();
    for verified in &creation.verified {
        insert_spec(db, session, verified)?;
        check(
            specs
                .insert(verified.node.node_id.clone(), verified.reference.clone())
                .is_none(),
            "spec_node_duplicate",
        )?;
    }
    let root = specs
        .get(&bundle.root_node_id)
        .ok_or_else(|| error("spec_required"))?;
    let edge_count: usize = bundle.tasks.iter().map(|t| t.after.len()).sum();
    let created_at: String = db
        .query_row(
            "SELECT created_at FROM wm_intents WHERE session_id=?1 AND operation_key=?2",
            params![session, request.idempotency_key],
            |r| r.get(0),
        )
        .map_err(sql)?;
    db.execute("INSERT INTO wm_plans(scope_id,id,owner_session_id,instruction_id,root_node_id,root_revision,tier,objective,graph_revision,tree_version,status,spec_count,task_count,edge_count,created_at,updated_at) VALUES(?1,?2,?1,?3,?4,?5,?6,?7,1,1,'ready',?8,?9,?10,?11,?11)",
        params![session,plan_id,request.instruction_id,root.node_id,root.node_revision,bundle.tier,bundle.goal,bundle.nodes.len(),bundle.tasks.len(),edge_count,created_at]).map_err(sql)?;
    for node in &bundle.nodes {
        db.execute("INSERT INTO wm_tree(scope_id,plan_id,node_id,node_revision,parent_id,concern_id) VALUES(?1,?2,?3,?4,?5,?6)",
            params![session,plan_id,node.node_id,node.node_revision,node.parent_id,node.concern_id]).map_err(sql)?;
    }
    db.execute(
        "INSERT INTO wm_sessions(session_id,scope_id,plan_id,routing_reason) VALUES(?1,?1,?2,?3) ON CONFLICT(session_id) DO UPDATE SET scope_id=excluded.scope_id,plan_id=excluded.plan_id,current_task_id=NULL,selected_task_id=NULL,routing_reason=excluded.routing_reason",
        params![
            session,
            plan_id,
            if bundle.tier == 1 {
                "small_multi_step"
            } else {
                "full_design"
            }
        ],
    )
    .map_err(sql)?;
    insert_coverage(db, session, &plan_id, bundle)?;
    let work_ids = insert_works(db, session, &plan_id, bundle, &specs)?;
    insert_tasks(db, session, &plan_id, request, bundle, &specs, &work_ids)?;
    insert_edges_and_counts(db, session, &plan_id, request, bundle)?;
    Ok(
        json!({"ok":true,"plan_id":plan_id,"tier":bundle.tier,"graph_revision":1,"tree_version":1,
        "published_refs":creation.verified.iter().map(|v| &v.reference).collect::<Vec<_>>(),
        "task_ids":bundle.tasks.iter().map(|t| stable_id("TASK", &plan_id, &t.key)).collect::<Result<Vec<_>>>()?}),
    )
}

fn insert_spec(db: &Connection, scope: &str, spec: &VerifiedSpec) -> Result<()> {
    let node = &spec.node;
    let reference = &spec.reference;
    db.execute(
        "INSERT INTO wm_specs VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![
            scope,
            node.node_id,
            node.node_revision,
            reference.ledger_revision_id,
            reference.content_hash,
            encode(reference)?,
            node.parent_id,
            node.concern_id,
            node.independent_review
        ],
    )
    .map_err(sql)?;
    for part in &node.parts {
        db.execute(
            "INSERT INTO wm_parts VALUES(?1,?2,?3,?4)",
            params![scope, node.node_id, node.node_revision, part.id],
        )
        .map_err(sql)?;
    }
    for criterion in &node.criteria {
        db.execute(
            "INSERT INTO wm_criteria VALUES(?1,?2,?3,?4,?5)",
            params![
                scope,
                node.node_id,
                node.node_revision,
                criterion.id,
                criterion.part_id
            ],
        )
        .map_err(sql)?;
    }
    Ok(())
}

fn insert_tasks(
    db: &Connection,
    scope: &str,
    plan: &str,
    request: &WorkModelRequest,
    bundle: &InitialBundle,
    specs: &HashMap<String, SpecRef>,
    works: &HashMap<String, String>,
) -> Result<()> {
    let created_at: String = db
        .query_row(
            "SELECT created_at FROM wm_plans WHERE scope_id=?1 AND id=?2",
            params![scope, plan],
            |r| r.get(0),
        )
        .map_err(sql)?;
    let origin = CreationOrigin {
        scope,
        instruction: &request.instruction_id,
        at: &created_at,
    };
    let mut task_statement = db
        .prepare_cached("INSERT INTO wm_tasks VALUES(?1,?2,?3,?4,?5,?6,?7,'pending',1,?8)")
        .map_err(sql)?;
    let mut criteria_statement = db
        .prepare_cached("INSERT INTO wm_task_criteria VALUES(?1,?2,?3,?4,?5,?6)")
        .map_err(sql)?;
    for (rank, draft) in bundle.tasks.iter().enumerate() {
        let reference = specs
            .get(&draft.node_id)
            .ok_or_else(|| error("spec_required"))?;
        let work = works
            .get(&draft.work_key)
            .ok_or_else(|| error("task_work_invalid"))?;
        let card = task_card(&origin, plan, draft, reference, work, rank)?;
        task_statement
            .execute(params![
                scope,
                plan,
                work,
                card.id,
                reference.node_id,
                reference.node_revision,
                rank,
                encode(&card)?
            ])
            .map_err(sql)?;
        for criterion in &draft.criterion_ids {
            criteria_statement
                .execute(params![
                    scope,
                    plan,
                    card.id,
                    reference.node_id,
                    reference.node_revision,
                    criterion
                ])
                .map_err(sql)?;
        }
    }
    Ok(())
}

fn insert_works(
    db: &Connection,
    session: &str,
    plan_id: &str,
    bundle: &InitialBundle,
    specs: &HashMap<String, SpecRef>,
) -> Result<HashMap<String, String>> {
    let mut work_ids = HashMap::new();
    for (rank, work) in bundle.works.iter().enumerate() {
        let id = stable_id("WORK", plan_id, &work.key)?;
        let reference = specs
            .get(&work.node_id)
            .ok_or_else(|| error("spec_required"))?;
        db.execute(
            "INSERT INTO wm_works(scope_id,plan_id,id,node_id,node_revision,rank,outcome,status,binding_json,created_at,updated_at) SELECT ?1,?2,?3,?4,?5,?6,?7,'ready',?8,created_at,created_at FROM wm_plans WHERE scope_id=?1 AND id=?2",
            params![
                session,
                plan_id,
                id,
                reference.node_id,
                reference.node_revision,
                rank,
                work.outcome,
                encode(work)?
            ],
        )
        .map_err(sql)?;
        work_ids.insert(work.key.clone(), id);
    }
    Ok(work_ids)
}

fn insert_coverage(db: &Connection, scope: &str, plan: &str, bundle: &InitialBundle) -> Result<()> {
    let revisions = bundle
        .nodes
        .iter()
        .map(|n| (&n.node_id, n.node_revision))
        .collect::<HashMap<_, _>>();
    for node in &bundle.nodes {
        for mapping in &node.child_coverage {
            let revision = revisions
                .get(&mapping.child_node_id)
                .ok_or_else(|| error("coverage_invalid"))?;
            db.execute(
                "INSERT INTO wm_coverage VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![
                    scope,
                    plan,
                    node.node_id,
                    node.node_revision,
                    mapping.criterion_id,
                    mapping.child_node_id,
                    revision,
                    mapping.child_criterion_id,
                    if mapping.semantics == CoverageSemantics::All {
                        "all"
                    } else {
                        "any"
                    }
                ],
            )
            .map_err(sql)?;
        }
    }
    Ok(())
}

fn insert_edges_and_counts(
    db: &Connection,
    session: &str,
    plan_id: &str,
    request: &WorkModelRequest,
    bundle: &InitialBundle,
) -> Result<()> {
    let mut edges = db
        .prepare_cached("INSERT INTO wm_edges VALUES(?1,?2,?3,?4,?5)")
        .map_err(sql)?;
    for task in &bundle.tasks {
        for predecessor in &task.after {
            edges
                .execute(params![
                    session,
                    plan_id,
                    stable_id("TASK", plan_id, predecessor)?,
                    stable_id("TASK", plan_id, &task.key)?,
                    request.idempotency_key
                ])
                .map_err(sql)?;
        }
    }
    db.execute(
        "INSERT INTO wm_counts VALUES(?1,?2,'pending',?3)",
        params![session, plan_id, bundle.tasks.len()],
    )
    .map_err(sql)?;
    Ok(())
}

struct CreationOrigin<'a> {
    scope: &'a str,
    instruction: &'a str,
    at: &'a str,
}

fn task_card(
    origin: &CreationOrigin<'_>,
    plan: &str,
    draft: &TaskDraft,
    reference: &SpecRef,
    work: &str,
    rank: usize,
) -> Result<TaskCard> {
    Ok(TaskCard {
        id: stable_id("TASK", plan, &draft.key)?,
        scope: json!({"session_id":origin.scope}),
        title: draft.description.clone(),
        origin_instruction_id: origin.instruction.into(),
        author: origin.scope.into(),
        created_at: origin.at.into(),
        updated_at: origin.at.into(),
        work_id: work.into(),
        spec_ref: reference.clone(),
        description: draft.description.clone(),
        kind: draft.kind,
        allow_nested_delegation: draft.allow_nested_delegation,
        part_ids: draft.part_ids.clone(),
        criterion_ids: draft.criterion_ids.clone(),
        rank: i64::try_from(rank).map_err(|_| error("task_rank_overflow"))?,
        status: "pending".into(),
        revision: 1,
        result_revision: 0,
        assignee_session_id: None,
        result_refs: vec![],
        evidence_refs: vec![],
        review_id: None,
        blocked_reason: None,
    })
}
