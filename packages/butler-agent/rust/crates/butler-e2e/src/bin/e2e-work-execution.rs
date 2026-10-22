//! Native execution flow through the production writer lane; no model calls.
#![allow(clippy::unwrap_used, reason = "companion assertions")]
use butler_turn::btcc::{BtccStorage, TestStorageFixture};
use butler_work::{
    store::{execution::*, parts::*, *},
    work_types::*,
};
use serde_json::json;
type Failure = Box<dyn std::error::Error + Send + Sync>;
#[path = "e2e-work-execution/batch.rs"]
mod batch;
#[path = "e2e-work-execution/failure.rs"]
mod failure;

#[tokio::main]
async fn main() -> std::result::Result<(), Failure> {
    let path =
        std::path::PathBuf::from(std::env::args_os().nth(1).ok_or("database path required")?);
    let fixture = TestStorageFixture::activated();
    let mut config = fixture.config("work-execution");
    config.activation.manifest_id = rusqlite::Connection::open(&path)?.query_row(
        "SELECT manifest_id FROM agent_storage_activation_marker WHERE singleton=1",
        [],
        |r| r.get(0),
    )?;
    config.path = path;
    let storage = BtccStorage::open(config).await?;
    let result = storage.work_model_write(flow).await;
    storage.close().await?;
    result?;
    Ok(())
}
fn flow(tx: &Transaction<'_>) -> Result<()> {
    let ctx = Context {
        now: 100,
        actor: json!({"origin":"chat"}),
    };
    seed(tx, &ctx)?;
    let scope = ExecutionScope {
        session_id: "chat",
        turn_id: "turn",
    };
    let rev = |id: &str| read_task(tx, id).unwrap()["revision"].as_i64().unwrap();
    start_task(tx, &ctx, "task", rev("task"), &scope, "attempt")?;
    assert!(start_task(tx, &ctx, "task", rev("task"), &scope, "duplicate").is_err());
    for id in ["execute", "integrate", "review"] {
        let part = read_part(tx, id)?;
        let epoch = part["revision"].as_i64().unwrap();
        start_part(tx, &ctx, id, epoch, &scope, &format!("attempt-{id}"))?;
        assert_eq!(
            read_task(tx, "task")?["status"],
            if id == "execute" {
                "running"
            } else {
                "in_review"
            }
        );
        submit_task(
            tx,
            &ctx,
            "task",
            &scope,
            &Submission {
                part_id: Some(id),
                result_id: &format!("result-{id}"),
                result_refs: &[format!("artifact-{id}")],
                evidence_refs: &[format!("evidence-{id}")],
            },
        )?;
    }
    assert!(complete_task(tx, &ctx, "task", "chat", "missing", true).is_err());
    let judged = [CriterionResult {
        criterion_ref: CriterionRef {
            node_id: "spec".into(),
            node_revision: 1,
            criterion_id: "criterion".into(),
        },
        met: true,
        evidence_refs: vec!["evidence".into()],
        note: "checked".into(),
    }];
    assert!(
        review_task(
            tx,
            &ctx,
            "task",
            "chat",
            &ReviewInput {
                result_revision: 3,
                review_id: "incomplete",
                accept: true,
                judgments: &[]
            }
        )
        .is_err()
    );
    review_task(
        tx,
        &ctx,
        "task",
        "chat",
        &ReviewInput {
            result_revision: 3,
            review_id: "accepted",
            accept: true,
            judgments: &judged,
        },
    )?;
    // A new submission invalidates even an accepted review.
    submit_task(
        tx,
        &ctx,
        "task",
        &scope,
        &Submission {
            part_id: None,
            result_id: "result-final",
            result_refs: &["artifact".into()],
            evidence_refs: &["evidence".into()],
        },
    )?;
    assert!(complete_task(tx, &ctx, "task", "chat", "accepted", true).is_err());
    review_task(
        tx,
        &ctx,
        "task",
        "chat",
        &ReviewInput {
            result_revision: 4,
            review_id: "final-review",
            accept: true,
            judgments: &judged,
        },
    )?;
    complete_task(tx, &ctx, "task", "chat", "final-review", true)?;
    assert_eq!(read_task(tx, "task")?["status"], "completed");
    assert_eq!(read_task(tx, "task")?["result_reported_at"], 100);
    assert_eq!(read_work(tx, "work")?["run_state"], "idle");
    let count: i64 = tx.query_row(
        "SELECT count(*) FROM wm_tasks WHERE work_id='work'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(count, 1, "integrate/review stay hidden parts");
    failure::exercise(tx, &ctx)?;
    batch::exercise(tx)?;
    Ok(())
}
fn seed(tx: &Transaction<'_>, ctx: &Context) -> Result<()> {
    create_work(
        tx,
        ctx,
        &NewWork {
            id: "work".into(),
            scope_kind: ScopeKind::Session,
            scope_ref: "chat".into(),
            title: "Deliver result".into(),
            description: String::new(),
            origin: Origin::Chat,
            draft: false,
        },
        &Registration::Private,
    )?;
    create_spec_node(
        tx,
        ctx,
        &NewSpecNode {
            id: "spec".into(),
            scope_kind: ScopeKind::Session,
            scope_ref: "chat".into(),
            work_id: Some("work".into()),
            parent_node_id: None,
            concern_id: "goal".into(),
        },
        &Registration::Private,
    )?;
    let hash = put_body(tx, "Deliver a verified result")?;
    publish_spec(
        tx,
        ctx,
        "spec",
        0,
        &Publication {
            revision: 1,
            body_hash: hash.clone(),
            parser_version: "structured-1".into(),
            authoring_instruction_id: None,
            criteria: vec![Criterion {
                id: "criterion".into(),
                part_id: "goal".into(),
                text: "Result is verified".into(),
            }],
        },
    )?;
    activate_spec(tx, ctx, "spec", 1, None, 1)?;
    create_task(
        tx,
        ctx,
        &NewTask {
            id: "task".into(),
            work_id: "work".into(),
            title: "Deliver".into(),
            spec_ref: json!({"node_id":"spec","revision":1,"body_hash":hash}),
            draft: false,
            origin: QueueOrigin::Planner,
            origin_message_id: None,
        },
        0,
        "chain",
        None,
    )?;
    tx.execute(
        "INSERT INTO wm_task_criteria VALUES('task','spec',1,'criterion')",
        [],
    )?;
    let mut after = Vec::new();
    for (id, kind) in [
        ("execute", TaskKind::Execute),
        ("integrate", TaskKind::Integrate),
        ("review", TaskKind::Review),
    ] {
        add_part(
            tx,
            ctx,
            &NewPart {
                id,
                task_id: "task",
                kind,
                title: id,
                after_part_ids: &after,
            },
        )?;
        after = vec![id.into()];
    }
    Ok(())
}
