use super::*;
pub(super) fn exercise(tx: &Transaction<'_>, ctx: &Context) -> Result<()> {
    let spec: String = tx.query_row("SELECT spec_ref FROM wm_tasks WHERE id='task'", [], |r| {
        r.get(0)
    })?;
    for (id, after) in [("failure", None), ("later", Some("failure"))] {
        let graph = read_work(tx, "work")?["task_graph_revision"]
            .as_i64()
            .unwrap();
        create_task(
            tx,
            ctx,
            &NewTask {
                session: butler_work::store::TaskSession::Own,
                id: id.into(),
                work_id: "work".into(),
                title: id.into(),
                spec_ref: serde_json::from_str(&spec)?,
                draft: false,
                origin: QueueOrigin::Planner,
                origin_message_id: None,
            },
            graph,
            "failure-chain",
            after,
        )?;
        bind_criteria(
            tx,
            id,
            &[CriterionRef {
                node_id: "spec".into(),
                node_revision: 1,
                criterion_id: "criterion".into(),
            }],
        )?;
    }
    for (id, after) in [
        ("first", vec![]),
        ("sibling", vec![]),
        ("dependent", vec!["first".into()]),
    ] {
        add_part(
            tx,
            ctx,
            &NewPart {
                id,
                task_id: "failure",
                kind: TaskKind::Execute,
                title: id,
                after_part_ids: &after,
            },
        )?;
        if id == "first" {
            // The importer writes fixed-width numeric ranks, including zero.
            tx.execute(
                "UPDATE wm_task_parts SET part_rank='00000000000000000000' WHERE id=?1",
                [id],
            )?;
        }
    }
    assert!(
        edit_part(tx, ctx, "first", 0, None, Some(&["dependent".into()])).is_err(),
        "cycles are rejected"
    );
    let scope = ExecutionScope {
        session_id: "chat",
        turn_id: "failure-turn",
    };
    start_task(
        tx,
        ctx,
        "failure",
        read_task(tx, "failure")?["revision"].as_i64().unwrap(),
        &scope,
        "failure-attempt",
    )?;
    for id in ["first", "sibling"] {
        start_part(tx, ctx, id, 0, &scope, &format!("lease-{id}"))?;
    }
    fail_part(tx, ctx, "first", "chat", "task_failed")?;
    assert_eq!(
        read_task(tx, "failure")?["status"],
        "running",
        "running siblings may finish"
    );
    assert_eq!(read_part(tx, "sibling")?["status"], "running");
    fail_part(tx, ctx, "sibling", "chat", "task_failed")?;
    assert_eq!(read_task(tx, "failure")?["status"], "failed");
    assert_eq!(read_task(tx, "later")?["status"], "held");
    assert_eq!(read_work(tx, "work")?["run_state"], "failed");
    revision_fence(tx, ctx)?;
    Ok(())
}
fn revision_fence(tx: &Transaction<'_>, ctx: &Context) -> Result<()> {
    let previous = read_task(tx, "task")?;
    let spec = serde_json::from_str(previous["spec_ref"].as_str().unwrap())?;
    create_task(
        tx,
        ctx,
        &NewTask {
            session: butler_work::store::TaskSession::Own,
            id: "fenced".into(),
            work_id: "work".into(),
            title: "Continue".into(),
            spec_ref: spec,
            draft: false,
            origin: QueueOrigin::Planner,
            origin_message_id: None,
        },
        read_work(tx, "work")?["task_graph_revision"]
            .as_i64()
            .unwrap(),
        "fenced-chain",
        None,
    )?;
    bind_criteria(
        tx,
        "fenced",
        &[CriterionRef {
            node_id: "spec".into(),
            node_revision: 1,
            criterion_id: "criterion".into(),
        }],
    )?;
    let scope = ExecutionScope {
        session_id: "chat",
        turn_id: "fenced-turn",
    };
    start_task(
        tx,
        ctx,
        "fenced",
        read_task(tx, "fenced")?["revision"].as_i64().unwrap(),
        &scope,
        "fenced-attempt",
    )?;
    assert!(ensure_task_effect(tx, "fenced", "chat").is_ok());
    let hash = put_body(tx, "Updated acceptance")?;
    publish_spec(
        tx,
        ctx,
        "spec",
        2,
        &Publication {
            revision: 2,
            body_hash: hash,
            parser_version: "structured-1".into(),
            authoring_instruction_id: None,
            criteria: vec![Criterion {
                id: "criterion".into(),
                part_id: "goal".into(),
                text: "Updated criterion".into(),
            }],
        },
    )?;
    activate_spec(tx, ctx, "spec", 3, Some(1), 2)?;
    assert!(
        ensure_task_effect(tx, "fenced", "chat").is_err(),
        "an active criterion edit fences stale effects"
    );
    assert_eq!(
        read_task(tx, "task")?,
        previous,
        "completed Tasks stay unchanged"
    );
    fail_task(tx, ctx, "fenced", "chat", "spec_changed")?;
    Ok(())
}
