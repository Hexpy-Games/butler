use super::*;
use butler_work::store::{
    apply::{ApplyScope, apply},
    tool_ops::Apply,
};

pub(super) fn exercise(tx: &Transaction<'_>) -> Result<()> {
    let ctx = Context {
        now: 200,
        actor: json!({"origin":"chat"}),
    };
    let instruction = butler_work::cutover::accept(
        tx,
        &butler_work::cutover::ManagedAdmission {
            message_id: "request".into(),
            session_id: "batch-chat".into(),
            turn_id: "batch-turn".into(),
            body: "Deliver a checked artifact".into(),
            received_seq: 1,
            sender: json!({"user":"person"}),
        },
    )?;
    let scope = ApplyScope {
        session_id: "batch-chat".into(),
        turn_id: "batch-turn".into(),
        instruction_id: instruction,
        work_id: None,
        tier: 0,
        planning: false,
        floors: Default::default(),
        child_session: false,
    };
    let input: Apply = serde_json::from_value(
        json!({"reason":"Deliver the requested artifact","operations":[
            {"op":"work.create_light","goal":"Checked artifact","done_criteria":["Artifact exists","Checks pass"],
                "tasks":[[{"key":"a","title":"Build","description":"Create artifact","criteria":[0]},{"key":"s","title":"Prepare","description":"Prepare checks","criteria":[1]}],
                    [{"key":"b","title":"Check","description":"Verify artifact","criteria":[1]},
                     {"key":"c","title":"Document","description":"Describe artifact","criteria":[0,1]}]]},
            {"op":"task.start","task_id":"@a"}
        ]}),
    )?;
    let result = apply(tx, &ctx, &scope, &input)?;
    let work = result["work"]["id"].as_str().unwrap();
    let chains: i64 = tx.query_row(
        "SELECT count(*) FROM wm_task_chains WHERE work_id=?1",
        [work],
        |r| r.get(0),
    )?;
    assert_eq!(chains, 1, "a bootstrap stack creates one chain");
    let a = result["keys"]["a"].as_str().unwrap();
    let b = result["keys"]["b"].as_str().unwrap();
    let c = result["keys"]["c"].as_str().unwrap();
    assert_eq!(read_task(tx, a)?["status"], "running");
    assert_eq!(read_task(tx, b)?["step_index"], 1);
    assert_eq!(read_task(tx, c)?["step_index"], 1);
    assert_eq!(read_task(tx, b)?["chain_id"], read_task(tx, c)?["chain_id"]);
    let node = result["work"]["spec_node_id"].as_str().unwrap();
    let (revision, hash): (i64, String) = tx.query_row(
        "SELECT revision,body_hash FROM wm_spec_revisions WHERE node_id=?1 AND state='active'",
        [node],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let bound = ApplyScope {
        work_id: Some(work.into()),
        ..scope
    };
    let task_rev = read_task(tx, b)?["revision"].as_i64().unwrap();
    let conflict: Apply = serde_json::from_value(
        json!({"reason":"Revise structure","spec_ref":{"node_id":node,"revision":revision,"body_hash":hash},
        "expected_task_graph_revision":result["task_graph_revision"],"expected_revisions":{b:task_rev},"operations":[
            {"op":"task.edit","task_id":b,"patch":{"title":"New title"}},
            {"op":"task.start","task_id":b}
        ]}),
    )?;
    assert!(
        apply(tx, &ctx, &bound, &conflict).is_err(),
        "predecessor must finish first"
    );
    assert_eq!(
        read_task(tx, b)?["title"],
        "Check",
        "the earlier edit rolled back"
    );
    assert_eq!(read_task(tx, b)?["revision"], task_rev);
    assert_eq!(
        read_work(tx, work)?["task_graph_revision"],
        result["task_graph_revision"]
    );
    for invalid in [
        json!({"op":"task.start","task_id":a,"visibility":"canon"}),
        json!({"op":"dependency.edit","pred":a,"succ":b}),
        json!({"op":"task.edit","task_id":a,"patch":{"visibility":"canon"}}),
        json!({"op":"task.pause","task_id":a}),
    ] {
        assert!(
            serde_json::from_value::<Apply>(json!({"reason":"invalid","operations":[invalid]}))
                .is_err()
        );
    }
    super::tiers::exercise(tx, &ctx, work, a)?;
    fail_task(tx, &ctx, a, "batch-chat", "task_failed")?;
    assert_eq!(read_task(tx, b)?["status"], "held");
    assert_eq!(read_task(tx, c)?["status"], "held");
    assert_eq!(read_work(tx, work)?["run_state"], "failed");
    Ok(())
}
