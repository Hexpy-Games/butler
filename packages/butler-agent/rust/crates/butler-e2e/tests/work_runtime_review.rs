//! Durable delegation boundaries, without a provider or timing-dependent races.
#![allow(clippy::unwrap_used, reason = "regression assertions")]
use butler_turn::btcc::{BtccStorage, SqliteSubsessionRepository, TestStorageFixture};
use butler_work::{
    store::{self, execution::*, *},
    work_types::TaskKind,
};
use serde_json::json;
#[path = "work_runtime_review/worker_cap.rs"]
mod worker_cap;
type Failure = Box<dyn std::error::Error + Send + Sync>;

fn seed(tx: &Transaction<'_>) -> store::Result<()> {
    let ctx = context();
    let instruction = butler_work::cutover::accept(
        tx,
        &butler_work::cutover::ManagedAdmission {
            message_id: "request".into(),
            session_id: "parent".into(),
            turn_id: "parent-turn".into(),
            body: "Build output".into(),
            received_seq: 1,
            sender: json!({"user":{"principal_id":"person"}}),
        },
    )?;
    let scope = apply::ApplyScope {
        session_id: "parent".into(),
        turn_id: "parent-turn".into(),
        instruction_id: instruction,
        work_id: None,
        tier: 1,
        planning: false,
        floors: Default::default(),
        child_session: false,
    };
    let input = serde_json::from_value(
        json!({"reason":"Build and verify requested output", "operations":[
            {"op":"work.create_light", "goal":"Build output", "done_criteria":["Built", "Verified"],
             "tasks":[[{"key":"t", "title":"Build", "description":"Verified output"}]]},
            {"op":"task.start", "task_id":"@t"}
        ]}),
    )?;
    let created = apply::apply(tx, &ctx, &scope, &input)?;
    let task = created["keys"]["t"].as_str().unwrap();
    for child in ["first", "second"] {
        add_part(
            tx,
            &ctx,
            &NewPart {
                id: child,
                task_id: task,
                kind: TaskKind::Execute,
                title: child,
                after_part_ids: &[],
            },
        )?;
        assign_part(
            tx,
            &ctx,
            child,
            0,
            "parent",
            &ExecutionScope {
                session_id: child,
                turn_id: child,
            },
            child,
        )?;
        tiers::admit(
            tx,
            &ctx,
            child,
            created["work"]["id"].as_str().unwrap(),
            1,
            "Assigned output",
        )?;
        tiers::bind_started_task(tx, child, task)?;
        tx.execute("INSERT INTO btcc_session_relations(relation_id,parent_session_id,parent_turn_id,child_session_id,anchor_message_id,ordinal,safe_title,created_at) VALUES(?1,'parent','parent-turn',?1,'anchor',?2,?1,'now')", rusqlite::params![child,if child=="first" {1}else{2}])?;
    }
    Ok(())
}
fn context() -> Context {
    Context {
        now: 100,
        actor: json!({"origin":"chat"}),
    }
}
async fn open() -> std::result::Result<(TestStorageFixture, BtccStorage), Failure> {
    let fixture = TestStorageFixture::activated();
    let storage = BtccStorage::open(fixture.config("runtime-review")).await?;
    storage.work_model_write(seed).await?;
    Ok((fixture, storage))
}
// test-category: pure-logic
#[tokio::test]
async fn held_children_do_not_block_the_parent_queue() -> std::result::Result<(), Failure> {
    butler_e2e::gate!();
    let (_fixture, storage) = open().await?;
    let children = SqliteSubsessionRepository::new(storage.clone());
    assert!(children.has_active_child("parent".into()).await?);
    storage
        .work_model_write(|tx| {
            hold_session(tx, &context(), "first", "pause", "parent")?;
            hold_session(tx, &context(), "second", "stop", "parent")?;
            Ok(())
        })
        .await?;
    assert!(
        !children.has_active_child("parent".into()).await?,
        "held attempts must not strand the parent's queue"
    );
    storage.close().await?;
    Ok(())
}
// test-category: pure-logic
#[tokio::test]
async fn blocking_one_part_keeps_its_sibling_attempt_live() -> std::result::Result<(), Failure> {
    butler_e2e::gate!();
    let (_fixture, storage) = open().await?;
    storage
        .work_model_write(|tx| {
            let task = read_part(tx, "first")?["task_id"]
                .as_str()
                .unwrap()
                .to_owned();
            block_task(
                tx,
                &context(),
                &task,
                Some("first"),
                "first",
                "Needs input",
                None,
            )?;
            let submitted = submit_task(
                tx,
                &context(),
                &task,
                &ExecutionScope {
                    session_id: "second",
                    turn_id: "second",
                },
                &Submission {
                    part_id: Some("second"),
                    result_id: "sibling-output",
                    result_refs: &["built".into()],
                    evidence_refs: &["verified".into()],
                },
            )?;
            assert_eq!(submitted["result_revision"], 1);
            assert_eq!(read_part(tx, "second")?["status"], "completed");
            Ok(())
        })
        .await?;
    storage.close().await?;
    Ok(())
}

// test-category: pure-logic
#[tokio::test]
async fn reporting_requires_every_child_and_allows_later_review() -> std::result::Result<(), Failure>
{
    butler_e2e::gate!();
    for deliver_before_review in [false, true] {
        let (_fixture, storage) = open().await?;
        storage
            .work_model_write(move |tx| {
                let task = read_part(tx, "first")?["task_id"]
                    .as_str()
                    .unwrap()
                    .to_owned();
                for child in ["first", "second"] {
                    submit_task(
                        tx,
                        &context(),
                        &task,
                        &ExecutionScope {
                            session_id: child,
                            turn_id: child,
                        },
                        &Submission {
                            part_id: Some(child),
                            result_id: child,
                            result_refs: &["output".into()],
                            evidence_refs: &["check".into()],
                        },
                    )?;
                    deliver_delegated_result(tx, &context(), child)?;
                }
                end_delegated_delivery(tx, &context(), "first", "parent")?;
                if deliver_before_review {
                    end_delegated_delivery(tx, &context(), "second", "parent")?;
                }
                accept_and_complete(tx, &task, "accepted", 2)?;
                assert_eq!(
                    !read_task(tx, &task)?["result_reported_at"].is_null(),
                    deliver_before_review
                );
                end_delegated_delivery(tx, &context(), "second", "parent")?;
                assert_eq!(read_task(tx, &task)?["result_reported_at"], 100);
                Ok(())
            })
            .await?;
        storage.close().await?;
    }
    Ok(())
}
fn accept_and_complete(
    tx: &Transaction<'_>,
    task: &str,
    review: &str,
    result_revision: i64,
) -> store::Result<()> {
    let judgments=tool_read::read(tx,"parent",&serde_json::from_value(json!({"view":"task","task_id":task}))?,1,false)?["view"]["criteria"]
        .as_array().unwrap().iter().map(|criterion|serde_json::from_value(json!({"criterion_ref":criterion,"met":true,"evidence_refs":["check"],"note":"Verified"}))).collect::<std::result::Result<Vec<CriterionResult>,_>>()?;
    review_task(
        tx,
        &context(),
        task,
        "parent",
        &ReviewInput {
            result_revision,
            review_id: review,
            accept: true,
            judgments: &judgments,
        },
    )?;
    complete_task(tx, &context(), task, "parent", review, true)?;
    Ok(())
}

// test-category: format-pin
#[tokio::test]
async fn native_runtime_statements_use_indexes() -> std::result::Result<(), Failure> {
    butler_e2e::gate!();
    let (_fixture, storage) = open().await?;
    storage
        .work_model_read(|db| {
            let mut recovery = serde_json::Map::new();
            let mut workers = serde_json::Map::new();
            for (name, sql) in butler_turn::btcc::native_query_statements() {
                let mut stmt = db.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
                let n = stmt.parameter_count();
                let plan = stmt
                    .query_map(
                        rusqlite::params_from_iter(std::iter::repeat_n(
                            rusqlite::types::Value::Null,
                            n,
                        )),
                        |r| r.get::<_, String>(3),
                    )?
                    .collect::<rusqlite::Result<Vec<_>>>()?
                    .join("\n");
                if name.starts_with("WORKER_") || name == "SUBSESSIONS_SERVICE_TASK_PART_COUNTS" {
                    workers.insert(name.into(), json!(plan));
                }
                if name.starts_with("LEGACY_RECOVERY_") {
                    recovery.insert(name.into(), json!(plan));
                }
                assert!(
                    !plan.lines().any(|line| line.starts_with("SCAN ")
                        && !line.contains("USING ")
                        && !line.contains("CONSTANT ROW")),
                    "{name}: {plan}"
                );
            }
            let expected_workers: serde_json::Value = serde_json::from_str(include_str!(
                "../fixtures/work-model-p14/worker-dispatch-plans.json"
            ))?;
            assert_eq!(json!(workers), expected_workers);
            assert_eq!(recovery.len(), 9, "all recovery statements are pinned");
            let expected: serde_json::Value = serde_json::from_str(include_str!(
                "../fixtures/work-model-p14/native-recovery-plans.json"
            ))?;
            assert_eq!(json!(recovery), expected);
            Ok(())
        })
        .await?;
    storage.close().await?;
    Ok(())
}

// test-category: pure-logic
#[tokio::test]
async fn escalation_requires_only_the_authored_reason_and_keeps_ids()
-> std::result::Result<(), Failure> {
    butler_e2e::gate!();
    let (_fixture, storage) = open().await?;
    storage.work_model_write(|tx| {
        let id=read_part(tx,"first")?["task_id"].as_str().unwrap().to_owned();
        let task=read_task(tx,&id)?;
        let work=task["work_id"].as_str().unwrap().to_owned();
        let spec:serde_json::Value=serde_json::from_str(task["spec_ref"].as_str().unwrap())?;
        let scope=apply::ApplyScope {session_id:"parent".into(),turn_id:"parent-turn".into(),instruction_id:String::new(),work_id:Some(work.clone()),tier:1,planning:false,floors:Default::default(),child_session:false};
        let input=json!({"reason":"The job needs delegation","spec_ref":spec,"expected_task_graph_revision":read_work(tx,&work)?["task_graph_revision"],"operations":[{"op":"work.escalate","reason":"The job needs delegation"}]});
        let result=apply::apply_tool(tx,&context(),&scope,"escalate-call",&input)?;
        assert_eq!(result["ok"],true,"{result}");
        assert_eq!(read_work(tx,&work)?["tier"],2);
        assert_eq!(read_task(tx,&id)?,task);
        assert!(!tool_read::operations(2,false,true)["available"].as_array().unwrap().contains(&json!("work.escalate")));
        Ok(())
    }).await?;
    storage.close().await?;
    Ok(())
}

// test-category: pure-logic
#[tokio::test]
async fn redo_waits_for_its_new_delivery_after_earlier_results_were_reported()
-> std::result::Result<(), Failure> {
    butler_e2e::gate!();
    let (_fixture, storage) = open().await?;
    storage.work_model_write(|tx| {
        let task = read_part(tx,"first")?["task_id"].as_str().unwrap().to_owned();
        for child in ["first","second"] {
            submit_task(tx,&context(),&task,&ExecutionScope {session_id:child,turn_id:child},
                &Submission {part_id:Some(child),result_id:child,result_refs:&["output".into()],evidence_refs:&["check".into()]})?;
            deliver_delegated_result(tx,&context(),child)?;
            end_delegated_delivery(tx,&context(),child,"parent")?;
        }
        let judgments=tool_read::read(tx,"parent",&serde_json::from_value(json!({"view":"task","task_id":task}))?,1,false)?["view"]["criteria"]
            .as_array().unwrap().iter().map(|criterion|serde_json::from_value(json!({"criterion_ref":criterion,"met":false,"evidence_refs":[],"note":"Correction required"})))
            .collect::<std::result::Result<Vec<CriterionResult>,_>>()?;
        review_task(tx,&context(),&task,"parent",&ReviewInput {result_revision:2,review_id:"revise",accept:false,judgments:&judgments})?;
        add_part(tx,&context(),&NewPart {id:"redo",task_id:&task,kind:TaskKind::Execute,title:"Correct output",after_part_ids:&[]})?;
        assign_part(tx,&context(),"redo",0,"parent",&ExecutionScope {session_id:"redo",turn_id:"redo"},"redo")?;
        submit_task(tx,&context(),&task,&ExecutionScope {session_id:"redo",turn_id:"redo"},
            &Submission {part_id:Some("redo"),result_id:"redo",result_refs:&["corrected output".into()],evidence_refs:&["check".into()]})?;
        accept_and_complete(tx,&task,"accepted",3)?;
        assert!(read_task(tx,&task)?["result_reported_at"].is_null());
        deliver_delegated_result(tx,&context(),"redo")?;
        assert!(read_task(tx,&task)?["result_reported_at"].is_null());
        end_delegated_delivery(tx,&context(),"redo","parent")?;
        assert_eq!(read_task(tx,&task)?["result_reported_at"],100);
        assert_eq!(tx.query_row("SELECT count(*) FROM wm_results WHERE task_id=?1",[task],|r|r.get::<_,i64>(0))?,3);
        Ok(())
    }).await?;
    storage.close().await?;
    Ok(())
}

// test-category: pure-logic
#[tokio::test]
async fn blocking_all_parts_keeps_the_owner_lease_resumable() -> std::result::Result<(), Failure> {
    butler_e2e::gate!();
    let (_fixture, storage) = open().await?;
    storage.work_model_write(|tx| {
        let task=read_part(tx,"first")?["task_id"].as_str().unwrap().to_owned();
        for part in ["first","second"] {
            block_task(tx,&context(),&task,Some(part),part,"Needs input",None)?;
        }
        assert_eq!(read_task(tx,&task)?["status"],"blocked");
        let before=tx.query_row("SELECT id FROM wm_attempts WHERE task_id=?1 AND part_id IS NULL AND status='running'",[&task],|r|r.get::<_,String>(0))?;
        let started=start_task(tx,&context(),&task,read_task(tx,&task)?["revision"].as_i64().unwrap(),&ExecutionScope {session_id:"parent",turn_id:"resuming"},"resume")?;
        assert_eq!(started["attempt_id"],before);
        assert_eq!(read_task(tx,&task)?["status"],"running");
        Ok(())
    }).await?;
    storage.close().await?;
    Ok(())
}

// test-category: pure-logic
#[tokio::test]
async fn terminal_work_leases_do_not_gate_later_direct_turns() -> std::result::Result<(), Failure> {
    butler_e2e::gate!();
    let (_fixture, storage) = open().await?;
    storage
        .work_model_write(|tx| {
            assert!(tiers::effects_allowed_in_turn(
                tx,
                "parent",
                "later-turn",
                false
            )?);
            let task = read_part(tx, "first")?["task_id"]
                .as_str()
                .unwrap()
                .to_owned();
            submit_task(
                tx,
                &context(),
                &task,
                &ExecutionScope {
                    session_id: "first",
                    turn_id: "first",
                },
                &Submission {
                    part_id: Some("first"),
                    result_id: "done",
                    result_refs: &["output".into()],
                    evidence_refs: &["check".into()],
                },
            )?;
            for state in ["done", "cancelled"] {
                tx.execute("UPDATE wm_works SET run_state=?1", [state])?;
                assert!(tiers::effects_allowed_in_turn(
                    tx,
                    "parent",
                    "parent-turn",
                    false
                )?);
                assert!(!tiers::effects_allowed_in_turn(tx, "first", "first", true)?);
            }
            Ok(())
        })
        .await?;
    storage.close().await?;
    Ok(())
}

// test-category: race
#[tokio::test]
async fn submitted_children_still_gate_the_queue_until_their_result_turns_end()
-> std::result::Result<(), Failure> {
    butler_e2e::gate!();
    let (_fixture, storage) = open().await?;
    storage
        .work_model_write(|tx| {
            let task = read_part(tx, "first")?["task_id"]
                .as_str()
                .unwrap()
                .to_owned();
            for child in ["first", "second"] {
                submit_task(
                    tx,
                    &context(),
                    &task,
                    &ExecutionScope {
                        session_id: child,
                        turn_id: child,
                    },
                    &Submission {
                        part_id: Some(child),
                        result_id: child,
                        result_refs: &["output".into()],
                        evidence_refs: &["check".into()],
                    },
                )?;
            }
            Ok(())
        })
        .await?;
    let children = SqliteSubsessionRepository::new(storage.clone());
    assert!(
        children.has_active_child("parent".into()).await?,
        "submitting is not delivery to the parent"
    );
    storage
        .work_model_write(|tx| {
            for child in ["first", "second"] {
                deliver_delegated_result(tx, &context(), child)?;
            }
            end_delegated_delivery(tx, &context(), "first", "parent")?;
            Ok(())
        })
        .await?;
    assert!(
        children.has_active_child("parent".into()).await?,
        "one delivering turn remains"
    );
    storage
        .work_model_write(|tx| end_delegated_delivery(tx, &context(), "second", "parent"))
        .await?;
    assert!(!children.has_active_child("parent".into()).await?);
    storage.close().await?;
    Ok(())
}
