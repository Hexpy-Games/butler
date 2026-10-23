use super::*;
use butler_work::store::tiers::{self, Floors};

pub(super) fn exercise(tx: &Transaction<'_>, ctx: &Context, work: &str, task: &str) -> Result<()> {
    assert!(tiers::effects_allowed(tx, "direct-chat")?);
    let direct_rows: i64 = tx.query_row(
        "SELECT count(*) FROM wm_session_exec WHERE session_id='direct-chat'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(
        direct_rows, 0,
        "direct effects create no managed execution row"
    );
    assert!(tiers::effects_allowed(tx, "batch-chat")?);
    assert!(tiers::effects_allowed(tx, "other-managed-chat")?);
    tiers::admit(
        tx,
        ctx,
        "other-managed-chat",
        work,
        1,
        "same requested outcome",
    )?;
    assert!(!tiers::effects_allowed(tx, "other-managed-chat")?);
    let recorded: (i64, String, String) = tx.query_row(
        "SELECT tier,tier_reason,tier_policy_revision FROM wm_session_exec WHERE session_id='batch-chat'",
        [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)),
    )?;
    assert_eq!(recorded.0, 1);
    assert_eq!(recorded.1, "Deliver the requested artifact");
    assert_eq!(recorded.2, tiers::POLICY_REVISION);
    assert!(tiers::check_floor(tx, Some(work), 1, 1, Floors::default()).is_ok());
    assert!(tiers::check_floor(tx, Some(work), 1, 2, Floors::default()).is_err());
    for facts in [
        Floors {
            requested_analysis_or_report: true,
            ..Floors::default()
        },
        Floors {
            delegation_or_child_assignment: true,
            ..Floors::default()
        },
        Floors {
            planned_resumable_or_scheduled: true,
            ..Floors::default()
        },
    ] {
        assert!(tiers::check_floor(tx, Some(work), 1, 0, facts).is_err());
        tiers::check_floor(tx, Some(work), 2, 0, facts)?;
    }
    reject_growth(tx, ctx, work, task)?;
    // Escalation keeps the actual Work, Task and active attempt identities.
    let original = read_task(tx, task)?;
    let attempt = ensure_task_effect(tx, task, "batch-chat")?;
    escalate(tx, ctx, work, task)?;
    assert_eq!(read_work(tx, work)?["tier"], 2);
    let operations = butler_work::store::tool_read::read(
        tx,
        "batch-chat",
        &serde_json::from_value(json!({"view":"operations"}))?,
        1,
        false,
    )?;
    assert!(
        operations["operations"]["available"]
            .as_array()
            .unwrap()
            .contains(&json!("task.join_stack"))
    );
    assert_eq!(read_task(tx, task)?, original);
    assert_eq!(ensure_task_effect(tx, task, "batch-chat")?, attempt);
    assert!(tiers::admit(tx, ctx, "batch-chat", work, 1, "smaller continuation").is_err());
    assert!(tiers::effects_allowed(tx, "batch-chat")?);
    Ok(())
}

fn reject_growth(tx: &Transaction<'_>, ctx: &Context, work: &str, task: &str) -> Result<()> {
    use butler_work::store::{
        apply::{ApplyScope, apply},
        tool_ops::Apply,
    };
    let before = read_work(tx, work)?;
    let task = read_task(tx, task)?;
    let spec: serde_json::Value = serde_json::from_str(task["spec_ref"].as_str().unwrap())?;
    let input: Apply = serde_json::from_value(json!({
        "reason":"Add requested follow-up outcomes",
        "spec_ref":spec,
        "expected_task_graph_revision":before["task_graph_revision"],
        "operations":[
            {"op":"task.add","run_here":true,"title":"Follow up","description":"First outcome","step":"new"},
            {"op":"task.add","run_here":true,"title":"Verify follow-up","description":"Second outcome","step":"new"}
        ]
    }))?;
    let scope = ApplyScope {
        session_id: "batch-chat".into(),
        turn_id: "batch-turn".into(),
        instruction_id: String::new(),
        work_id: Some(work.into()),
        tier: 1,
        planning: false,
        floors: Default::default(),
        child_session: false,
    };
    assert!(
        matches!(apply(tx, ctx, &scope, &input), Err(Error::Invalid(message)) if message == "tier1_floor_exceeded")
    );
    let after = read_work(tx, work)?;
    assert_eq!(
        after, before,
        "a rejected growth batch rolls back the graph and tier"
    );
    let count: i64 = tx.query_row(tiers::sql::FLOOR_COUNT, [work], |r| r.get(0))?;
    assert_eq!(
        count, 4,
        "the earlier task.add in the rejected batch rolls back"
    );
    Ok(())
}

fn escalate(tx: &Transaction<'_>, ctx: &Context, work: &str, task: &str) -> Result<()> {
    use butler_work::store::{
        apply::{ApplyScope, apply},
        tool_ops::Apply,
    };
    let before = read_work(tx, work)?;
    let task = read_task(tx, task)?;
    let spec: serde_json::Value = serde_json::from_str(task["spec_ref"].as_str().unwrap())?;
    let input: Apply = serde_json::from_value(json!({
        "reason":"delegation required", "spec_ref":spec,
        "expected_task_graph_revision":before["task_graph_revision"],
        "operations":[
            {"op":"spec.propose","key":"detail","node":{"title":"Method","goal":"Verify the outcome","criteria":["Method checked"],"constraints":[]}},
            {"op":"spec.activate","expected_tree_version":0,"published_refs":[{"node_id":"@detail","revision":1,"body_hash":"@detail"}]},
            {"op":"task.add","run_here":true,"title":"Check method","description":"Verify the method","step":"new","acceptance_refs":[{"node_id":"@detail","node_revision":1,"criterion_id":"c0"}]},
            {"op":"work.escalate","reason":"delegation required"}
        ]
    }))?;
    let scope = ApplyScope {
        session_id: "batch-chat".into(),
        turn_id: "batch-turn".into(),
        instruction_id: tx.query_row(
            "SELECT id FROM wm_instructions WHERE idempotency_key='request'",
            [],
            |r| r.get(0),
        )?,
        work_id: Some(work.into()),
        tier: 1,
        planning: false,
        floors: Default::default(),
        child_session: false,
    };
    let result = apply(tx, ctx, &scope, &input)?;
    assert_eq!(result["work"]["tier"], 2);
    tiers::ensure_detail(tx, work)?;
    tiers::ensure_coverage(tx, work)?;
    Ok(())
}
