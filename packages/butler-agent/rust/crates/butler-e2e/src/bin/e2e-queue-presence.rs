//! Process-boundary probe of legacy queue presence and reader independence.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "fixture assertions"
)]
use butler_turn::btcc::{BtccStorage, SqliteSubsessionRepository, TestStorageFixture};
use rusqlite::Connection;

#[tokio::main]
async fn main() {
    let fixture = tokio::task::spawn_blocking(TestStorageFixture::activated)
        .await
        .unwrap();
    let config = fixture.config("queue-presence");
    let path = config.path.clone();
    let storage = BtccStorage::open(config).await.unwrap();
    let seed_path = path.clone();
    tokio::task::spawn_blocking(move || {
        let db = Connection::open(seed_path).unwrap();
        db.execute_batch("INSERT INTO btcc_session_relations(relation_id,parent_session_id,parent_turn_id,child_session_id,anchor_message_id,ordinal,safe_title,created_at)
            VALUES('r','parent','parent-turn','child','anchor',1,'Child','now');
            INSERT INTO btcc_subsession_delegations(delegation_id,relation_id,task_id,child_turn_id,root_work_id,packet_json,dispatch_intent_json,dispatch_state,created_at)
            VALUES('d','r','task','turn','work','{}','{}','enqueued','now');
            INSERT INTO btcc_turns(turn_id,session_id,inbox_id,trigger_key,original_message_id,original_message,admission_snapshot_ref,model_selection_json,context_json,semantic_state,suspension_reason,revision,execution_fence)
            VALUES('turn','child','inbox','trigger','message','Request','snapshot','{}','{}','admitted','authority_pending',1,1);")
            .unwrap();
    }).await.unwrap();
    let repository = SqliteSubsessionRepository::new(storage.clone());
    assert!(
        !repository
            .queue_waits_for_child("parent".into())
            .await
            .unwrap()
    );
    update(&path, "UPDATE btcc_turns SET suspension_reason=NULL").await;
    assert!(
        repository
            .queue_waits_for_child("parent".into())
            .await
            .unwrap()
    );
    update(&path, "UPDATE btcc_turns SET semantic_state='delivered'").await;
    assert!(
        !repository
            .queue_waits_for_child("parent".into())
            .await
            .unwrap()
    );
    update(
        &path,
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
        &path,
        "UPDATE btcc_session_relations SET activity_terminal=1",
    )
    .await;
    assert!(
        !repository
            .queue_waits_for_child("parent".into())
            .await
            .unwrap()
    );
    update(&path, "INSERT INTO btcc_steward_results(result_id,relation_id,task_id,child_session_id,child_turn_id,status,summary,acceptance_evidence_json,changed_artifacts_json,created_at)
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
        &path,
        "UPDATE btcc_subsession_outbox SET status='delivered'",
    )
    .await;
    assert!(
        !repository
            .queue_waits_for_child("parent".into())
            .await
            .unwrap()
    );
    update(&path, "DELETE FROM btcc_subsession_outbox; DELETE FROM btcc_steward_results; DELETE FROM btcc_turns; UPDATE btcc_session_relations SET activity_terminal=0; UPDATE btcc_subsession_delegations SET dispatch_state='pending'").await;
    assert!(
        repository
            .queue_waits_for_child("parent".into())
            .await
            .unwrap()
    );
    let writer = storage.clone();
    let (entered, ready) = tokio::sync::oneshot::channel();
    let (release, blocked) = std::sync::mpsc::channel();
    let busy = tokio::spawn(TestStorageFixture::hold_writer(writer, entered, blocked));
    ready.await.unwrap();
    let read = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        repository.queue_waits_for_child("parent".into()),
    )
    .await;
    release.send(()).unwrap();
    busy.await.unwrap().unwrap();
    assert!(
        read.expect("queue read must not wait for the BTCC writer")
            .unwrap()
    );
    storage.close().await.unwrap();
    println!(
        "legacy queue presence: held/terminal excluded; pending results retained; blocked writer does not delay reads"
    );
}

async fn update(path: &std::path::Path, sql: &'static str) {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || {
        Connection::open(path).unwrap().execute_batch(sql).unwrap();
    })
    .await
    .unwrap();
}
