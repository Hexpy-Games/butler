//! Legacy execution presence and reader isolation for gateway dispatch.
use super::*;
use crate::btcc::storage::{BtccStorage, testing::Fixture};

pub(in crate::btcc::storage) async fn queue_presence_excludes_held_children_and_does_not_wait_for_writer()
 {
    let fixture = Fixture::activated();
    let storage = BtccStorage::open(fixture.config("queue-presence"))
        .await
        .unwrap();
    storage.execute(|db| {
        db.execute_batch("INSERT INTO btcc_session_relations(relation_id,parent_session_id,parent_turn_id,child_session_id,anchor_message_id,ordinal,safe_title,created_at)
            VALUES('r','parent','parent-turn','child','anchor',1,'Child','now');
            INSERT INTO btcc_subsession_delegations(delegation_id,relation_id,task_id,child_turn_id,root_work_id,packet_json,dispatch_intent_json,dispatch_state,created_at)
            VALUES('d','r','task','turn','work','{}','{}','enqueued','now');
            INSERT INTO btcc_turns(turn_id,session_id,inbox_id,trigger_key,original_message_id,original_message,admission_snapshot_ref,model_selection_json,context_json,semantic_state,suspension_reason,revision,execution_fence)
            VALUES('turn','child','inbox','trigger','message','Request','snapshot','{}','{}','admitted','authority_pending',1,1);")
            .map_err(StorageError::sqlite)?;
        let plan = db.prepare(&format!("EXPLAIN QUERY PLAN {QUEUE_WAITS_FOR_CHILD}"))
            .map_err(StorageError::sqlite)?.query_map(["parent"], |row| row.get::<_,String>(3))
            .map_err(StorageError::sqlite)?.collect::<Result<Vec<_>,_>>().map_err(StorageError::sqlite)?.join("\n");
        for table in ["r", "d", "t", "latest", "x", "o"] {
            assert!(!plan.lines().any(|line| line.starts_with(&format!("SCAN {table}"))), "{plan}");
        }
        eprintln!("legacy child-presence query plan:\n{plan}");
        Ok(())
    }).await.unwrap();
    let repository = SqliteSubsessionRepository::new(storage.clone());
    assert!(
        !repository
            .queue_waits_for_child("parent".into())
            .await
            .unwrap()
    );
    update(&storage, "UPDATE btcc_turns SET suspension_reason=NULL").await;
    assert!(
        repository
            .queue_waits_for_child("parent".into())
            .await
            .unwrap()
    );
    update(&storage, "UPDATE btcc_turns SET semantic_state='delivered'").await;
    assert!(
        !repository
            .queue_waits_for_child("parent".into())
            .await
            .unwrap()
    );
    update(
        &storage,
        "UPDATE btcc_turns SET suspension_reason='waiting_for_worker'",
    )
    .await;
    assert!(
        repository
            .queue_waits_for_child("parent".into())
            .await
            .unwrap()
    );
    update(
        &storage,
        "UPDATE btcc_session_relations SET activity_terminal=1",
    )
    .await;
    assert!(
        !repository
            .queue_waits_for_child("parent".into())
            .await
            .unwrap()
    );
    update(&storage, "INSERT INTO btcc_steward_results(result_id,relation_id,task_id,child_session_id,child_turn_id,status,summary,acceptance_evidence_json,changed_artifacts_json,created_at)
        VALUES('result','r','task','child','turn','success','Complete','[]','[]','now');
        INSERT INTO btcc_subsession_outbox(outbox_id,relation_id,result_id,parent_session_id,parent_turn_id,message_id,input_json,status,created_at)
        VALUES('outbox','r','result','parent','parent-turn','result-message','{}','pending','now')").await;
    assert!(
        repository
            .queue_waits_for_child("parent".into())
            .await
            .unwrap()
    );
    update(
        &storage,
        "UPDATE btcc_subsession_outbox SET status='delivered'",
    )
    .await;
    assert!(
        !repository
            .queue_waits_for_child("parent".into())
            .await
            .unwrap()
    );
    update(&storage, "DELETE FROM btcc_subsession_outbox; DELETE FROM btcc_steward_results; DELETE FROM btcc_turns; UPDATE btcc_session_relations SET activity_terminal=0; UPDATE btcc_subsession_delegations SET dispatch_state='pending'").await;
    assert!(
        repository
            .queue_waits_for_child("parent".into())
            .await
            .unwrap()
    );
    let writer = storage.clone();
    let (entered, ready) = tokio::sync::oneshot::channel();
    let (release, blocked) = std::sync::mpsc::channel();
    let busy = tokio::spawn(async move {
        writer
            .execute(move |_| {
                entered.send(()).unwrap();
                blocked.recv().unwrap();
                Ok(())
            })
            .await
            .unwrap();
    });
    ready.await.unwrap();
    let read = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        repository.queue_waits_for_child("parent".into()),
    )
    .await;
    release.send(()).unwrap();
    busy.await.unwrap();
    assert!(
        read.expect("queue read must not wait for the BTCC writer")
            .unwrap()
    );
    storage.close().await.unwrap();
}

async fn update(storage: &BtccStorage, sql: &'static str) {
    storage
        .execute(move |db| db.execute_batch(sql).map_err(StorageError::sqlite))
        .await
        .unwrap();
}
