//! Process-boundary probe of legacy queue presence and reader independence.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "fixture assertions"
)]
use butler_turn::btcc::{BtccStorage, SqliteSubsessionRepository, TestStorageFixture};
use rusqlite::Connection;
use std::path::Path;

#[tokio::main]
async fn main() {
    let fixture = tokio::task::spawn_blocking(TestStorageFixture::activated)
        .await
        .unwrap();
    let config = fixture.config("queue-presence");
    let path = config.path.clone();
    let storage = BtccStorage::open(config).await.unwrap();
    seed(&path).await;
    let repository = SqliteSubsessionRepository::new(storage.clone());
    presence(&path, &repository).await;
    descendants(&path, &repository).await;
    reader(&path, &repository, storage.clone()).await;
    storage.close().await.unwrap();
    println!(
        "legacy queue presence: held descendants excluded; closeout and continued children retained; blocked writer does not delay reads"
    );
}

async fn seed(path: &Path) {
    update(path, "INSERT INTO btcc_session_relations(relation_id,parent_session_id,parent_turn_id,child_session_id,anchor_message_id,ordinal,safe_title,created_at)
        VALUES('r','parent','parent-turn','child','anchor',1,'Child','now');
        INSERT INTO btcc_subsession_delegations(delegation_id,relation_id,task_id,child_turn_id,root_work_id,packet_json,dispatch_intent_json,dispatch_state,created_at)
        VALUES('d','r','task','turn','work','{}','{}','enqueued','now');
        INSERT INTO btcc_turns(turn_id,session_id,inbox_id,trigger_key,original_message_id,original_message,admission_snapshot_ref,model_selection_json,context_json,semantic_state,suspension_reason,revision,execution_fence)
        VALUES('turn','child','inbox','trigger','message','Request','snapshot','{}','{}','admitted','authority_pending',1,1);").await;
}

async fn expect(repository: &SqliteSubsessionRepository, expected: bool) {
    assert_eq!(
        repository
            .queue_waits_for_child("parent".into())
            .await
            .unwrap(),
        expected
    );
}

async fn presence(path: &Path, repository: &SqliteSubsessionRepository) {
    expect(repository, false).await;
    update(path, "UPDATE btcc_turns SET suspension_reason=NULL").await;
    expect(repository, true).await;
    update(path, "UPDATE btcc_turns SET semantic_state='delivered'").await;
    expect(repository, true).await; // Closeout has not saved the result yet.
    update(path, "INSERT INTO btcc_steward_results(result_id,relation_id,task_id,child_session_id,child_turn_id,status,summary,acceptance_evidence_json,changed_artifacts_json,created_at)
        VALUES('result','r','task','child','turn','success','Complete','[]','[]','now');
        INSERT INTO btcc_subsession_outbox(outbox_id,relation_id,result_id,parent_session_id,parent_turn_id,message_id,input_json,status,created_at)
        VALUES('outbox','r','result','parent','parent-turn','result-message','{}','pending','now')").await;
    expect(repository, true).await;
    update(path, "UPDATE btcc_subsession_outbox SET status='delivered'; UPDATE btcc_turns SET semantic_state='admitted'").await;
    expect(repository, false).await; // Interrupted turn state may lag its saved result.
    update(path, "INSERT INTO btcc_turns(turn_id,session_id,inbox_id,trigger_key,original_message_id,original_message,admission_snapshot_ref,model_selection_json,context_json,semantic_state,revision,execution_fence)
        VALUES('continued','child','continued-inbox','continued-trigger','continued-message','Continue','snapshot','{}','{}','admitted',1,1)").await;
    expect(repository, true).await; // activity_terminal remains one after the first result.
    update(
        path,
        "UPDATE btcc_turns SET suspension_reason='authority_pending' WHERE turn_id='continued'",
    )
    .await;
    expect(repository, false).await;
}

async fn descendants(path: &Path, repository: &SqliteSubsessionRepository) {
    update(path, "UPDATE btcc_turns SET suspension_reason='waiting_for_worker' WHERE turn_id='continued';
        INSERT INTO btcc_session_relations(relation_id,parent_session_id,parent_turn_id,child_session_id,anchor_message_id,ordinal,safe_title,created_at)
        VALUES('grand-r','child','continued','grandchild','grand-anchor',1,'Worker','now');
        INSERT INTO btcc_subsession_delegations(delegation_id,relation_id,task_id,child_turn_id,root_work_id,packet_json,dispatch_intent_json,dispatch_state,created_at)
        VALUES('grand-d','grand-r','grand-task','grand-turn','grand-work','{}','{}','enqueued','now');
        INSERT INTO btcc_turns(turn_id,session_id,inbox_id,trigger_key,original_message_id,original_message,admission_snapshot_ref,model_selection_json,context_json,semantic_state,suspension_reason,revision,execution_fence)
        VALUES('grand-turn','grandchild','grand-inbox','grand-trigger','grand-message','Request','snapshot','{}','{}','admitted','authority_pending',1,1);").await;
    expect(repository, false).await;
    update(
        path,
        "UPDATE btcc_turns SET suspension_reason=NULL WHERE session_id='grandchild'",
    )
    .await;
    expect(repository, true).await;
    update(path, "UPDATE btcc_turns SET suspension_reason='waiting_for_worker' WHERE session_id='grandchild'").await;
    expect(repository, false).await; // A waiting child with no runnable descendant is idle.
}

async fn reader(path: &Path, repository: &SqliteSubsessionRepository, storage: BtccStorage) {
    update(path, "DELETE FROM btcc_subsession_outbox; DELETE FROM btcc_steward_results; DELETE FROM btcc_turns;
        DELETE FROM btcc_subsession_delegations WHERE relation_id='grand-r';
        DELETE FROM btcc_session_relations WHERE relation_id='grand-r';
        UPDATE btcc_session_relations SET activity_terminal=0;
        UPDATE btcc_subsession_delegations SET dispatch_state='pending'").await;
    expect(repository, true).await;
    let (entered, ready) = tokio::sync::oneshot::channel();
    let (release, blocked) = std::sync::mpsc::channel();
    let busy = tokio::spawn(TestStorageFixture::hold_writer(storage, entered, blocked));
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
}

async fn update(path: &Path, sql: &'static str) {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || {
        Connection::open(path).unwrap().execute_batch(sql).unwrap();
    })
    .await
    .unwrap();
}
