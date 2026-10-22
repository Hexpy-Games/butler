//! Managed admission persists the request throughout a postponed switch.
#![allow(clippy::unwrap_used, reason = "test assertions")]
use butler_turn::btcc::{BtccStorage, CutoverAdmission, TestStorageFixture};
use butler_work::{
    cutover::{self, CutoverState, ManagedAdmission},
    store,
};
use serde_json::json;
use tokio_util::sync::CancellationToken;

// test-category: pure-logic
#[tokio::test]
async fn admission_returns_pending_through_postponed_and_failed_backup()
-> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    butler_e2e::gate!();
    for failed in [false, true] {
        let fixture = TestStorageFixture::activated();
        let storage = BtccStorage::open(fixture.config("managed-wait")).await?;
        storage
            .work_model_write(move |tx| {
                cutover::begin(tx, CutoverState::Pending)?;
                if failed {
                    cutover::fail_backup(tx, cutover::BackupFailureCode::Copy)?;
                }
                Ok(())
            })
            .await?;
        if !failed {
            storage.postpone_work_model_cutover();
        }
        let mut changes = storage.subscribe_changes();
        let waiting = storage.clone();
        let stop = CancellationToken::new();
        let task = tokio::spawn(async move {
            waiting
                .admit_work_model(
                    ManagedAdmission {
                        message_id: "original-message".into(),
                        session_id: "session".into(),
                        turn_id: "turn".into(),
                        body: "Write and check the requested files".into(),
                        received_seq: 7,
                        sender: json!({"user":{"principal_id":"person"}}),
                    },
                    &stop,
                )
                .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(5),async {
            loop {
                changes.borrow_and_update();
                let found = storage.work_model_read(|db| {
                    Ok(db.query_row("SELECT EXISTS(SELECT 1 FROM wm_instructions WHERE idempotency_key='original-message')",[],|r|r.get::<_,bool>(0))?)
                }).await?;
                if found { break; }
                changes.changed().await.unwrap();
            }
            Ok::<(),butler_turn::btcc::StorageError>(())
        }).await??;
        let admitted = tokio::time::timeout(std::time::Duration::from_secs(5), task).await???;
        assert!(
            matches!(admitted, CutoverAdmission::Pending(_)),
            "{admitted:?}"
        );
        storage
            .work_model_write(|tx| {
                cutover::resume(tx, CutoverState::Importing)?;
                let ctx = store::Context {
                    now: 1,
                    actor: json!({"origin":"migration"}),
                };
                while cutover::batch(tx, &ctx)? {}
                Ok(())
            })
            .await?;
        let row = storage.work_model_read(|db| {
            Ok(db.query_row("SELECT anchor_id,received_seq,status FROM wm_instructions WHERE idempotency_key='original-message'",[],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?)))?)
        }).await?;
        assert_eq!(row, ("turn".into(), 7, "waiting_for_turn".into()));
        storage.close().await?;
    }
    Ok(())
}
