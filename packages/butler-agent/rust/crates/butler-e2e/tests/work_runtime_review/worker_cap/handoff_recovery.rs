//! A failed handoff receipt cannot prevent the remaining startup work.
use super::*;
// test-category: race
#[tokio::test]
async fn bad_handoff_does_not_abort_other_handoffs_or_slot_recovery()
-> std::result::Result<(), Failure> {
    butler_e2e::gate!();
    let f = Fixture::open().await?;
    let good=f.storage.work_model_write(|tx| {
        let task=store::bound_work(tx,"parent",None)? .unwrap();
        let work=task["id"].as_str().unwrap();
        let good=tx.query_row("SELECT id FROM wm_tasks WHERE work_id=?1 AND status='running'",[work],|r|r.get::<_,String>(0))?;
        let spec:serde_json::Value=serde_json::from_str(read_task(tx,&good)?["spec_ref"].as_str().unwrap())?;
        create_task(tx,&context(),&NewTask {id:"000-unsettled".into(),work_id:work.into(),title:"Unsettled reservation".into(),spec_ref:spec,draft:false,origin:butler_work::work_types::QueueOrigin::Planner,origin_message_id:None,session:TaskSession::Own},read_work(tx,work)?["task_graph_revision"].as_i64().unwrap(),"unsettled-chain",None)?;
        tx.execute("UPDATE wm_tasks SET reserved_session_id=NULL,assignee_session_id='parent',handoff_to_session_id='next' WHERE id='000-unsettled'",[])?;
        take_here(tx,&context(),&good,"next",read_task(tx,&good)?["revision"].as_i64().unwrap())?;
        Ok(good)
    }).await?;
    f.service.recover_native_assignments(Vec::new()).await?;
    f.service.recover_waiting_workers().await?;
    f.storage
        .work_model_read(move |db| {
            assert_eq!(read_task(db, &good)?["assignee_session_id"], "next");
            assert!(read_task(db, &good)?["handoff_to_session_id"].is_null());
            assert!(active_session_holds(db, "parent")?.is_empty());
            assert_eq!(
                read_task(db, "000-unsettled")?["handoff_to_session_id"],
                "next"
            );
            Ok(())
        })
        .await?;
    f.close().await
}
