use super::*;
use butler_work::store::{
    apply::{ApplyScope, apply},
    tool_ops::Apply,
};
use rusqlite::params;

pub(super) fn exercise(tx: &Transaction<'_>, ctx: &Context) -> Result<()> {
    let completed = read_task(tx, "task")?;
    let previous: serde_json::Value =
        serde_json::from_str(completed["spec_ref"].as_str().unwrap())?;
    tx.execute(
        butler_work::store::execution::sql::WORK_SPEC,
        params!["work", "spec", 1],
    )?;
    let graph = read_work(tx, "work")?["task_graph_revision"]
        .as_i64()
        .unwrap();
    create_task(
        tx,
        ctx,
        &NewTask {
            session: butler_work::store::TaskSession::Own,
            id: "impact-active".into(),
            work_id: "work".into(),
            title: "Apply the result".into(),
            spec_ref: previous.clone(),
            draft: false,
            origin: QueueOrigin::Planner,
            origin_message_id: None,
        },
        graph,
        "chain",
        Some("task"),
    )?;
    bind_criteria(
        tx,
        "impact-active",
        &[CriterionRef {
            node_id: "spec".into(),
            node_revision: 1,
            criterion_id: "criterion".into(),
        }],
    )?;
    let active = read_task(tx, "impact-active")?;
    start_task(
        tx,
        ctx,
        "impact-active",
        active["revision"].as_i64().unwrap(),
        &ExecutionScope {
            session_id: "chat",
            turn_id: "impact-turn",
        },
        "impact-attempt",
    )?;
    let active = read_task(tx, "impact-active")?;
    let instruction = butler_work::cutover::accept(
        tx,
        &butler_work::cutover::ManagedAdmission {
            message_id: "criterion-edit".into(),
            session_id: "chat".into(),
            turn_id: "impact-turn".into(),
            body: "Use the revised acceptance criterion".into(),
            received_seq: 2,
            sender: json!({"user":"person"}),
        },
    )?;
    let scope = ApplyScope {
        session_id: "chat".into(),
        turn_id: "impact-turn".into(),
        instruction_id: instruction,
        work_id: Some("work".into()),
        tier: 1,
        planning: false,
        floors: Default::default(),
        child_session: false,
    };
    let graph = read_work(tx, "work")?["task_graph_revision"]
        .as_i64()
        .unwrap();
    let input = input(&previous, graph, &completed, &active)?;
    let mut missing = input.clone();
    if let butler_work::store::tool_ops::Operation::Activate { impact_map, .. } =
        &mut missing.operations[1]
    {
        impact_map.as_mut().unwrap().0.pop_last();
    }
    assert!(
        apply(tx, ctx, &scope, &missing).is_err(),
        "every consumer needs an explicit impact"
    );
    assert_eq!(
        read_task(tx, "impact-active")?,
        active,
        "a rejected activation does not interrupt execution"
    );
    let result = apply(tx, ctx, &scope, &input)?;
    assert!(result["ok"].as_bool().unwrap());
    assert_eq!(
        read_task(tx, "task")?,
        completed,
        "completed Task history is unchanged"
    );
    assert_eq!(read_task(tx, "impact-active")?["status"], "blocked");
    assert!(ensure_task_effect(tx, "impact-active", "chat").is_err());
    let attempt: String = tx.query_row(
        "SELECT status FROM wm_attempts WHERE id='impact-attempt'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(attempt, "interrupted");
    let corrective: (i64, i64) = tx.query_row(
        "SELECT count(*),max(step_index) FROM wm_tasks WHERE work_id='work' AND id NOT IN ('task','impact-active')",
        [], |r| Ok((r.get(0)?,r.get(1)?)),
    )?;
    assert_eq!(
        corrective,
        (2, 2),
        "correction follows its affected Task's step"
    );
    assert_eq!(read_work(tx, "work")?["run_state"], "blocked");
    Ok(())
}
fn input(
    previous: &serde_json::Value,
    graph: i64,
    completed: &serde_json::Value,
    active: &serde_json::Value,
) -> Result<Apply> {
    Ok(serde_json::from_value(json!({
        "reason":"Apply the approved criterion revision", "spec_ref":previous,
        "expected_task_graph_revision":graph,"expected_revisions":{"spec":2,"task":completed["revision"],"impact-active":active["revision"]},
        "operations":[
            {"op":"spec.propose","key":"edited","node_id":"spec","base_revision":1,
                "node":{"title":"Result","goal":"Deliver the checked result","criteria":["Verify against the revised criterion"],"constraints":[]}},
            {"op":"spec.activate","expected_tree_version":0,
                "published_refs":[{"node_id":"@edited","revision":3,"body_hash":"@edited"}],
                "impact_map":{
                    "task":{"action":"reverify","reason":"Apply the revised acceptance check"},
                    "impact-active":{"action":"reverify","reason":"Check the changed acceptance condition"}
                }}
        ]
    }))?)
}
