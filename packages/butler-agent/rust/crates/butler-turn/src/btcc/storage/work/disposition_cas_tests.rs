//! Compare-and-swap of a runtime-owned open disposition on real SQLite: the
//! command's own attachment of the Turn's completed tool results is not a
//! concurrent change; any other change between the caller's read and the
//! command is.

use crate::btcc::disposition_material_fingerprint;
use crate::btcc::work::*;

use super::tests::{journal_result, opened, plan, review, scope};

/// The runtime closeout's disposition (`settle_open`) for `expected`.
fn runtime_open(call: &str, work_id: &str, expected: String) -> DispositionInput {
    DispositionInput {
        scope: scope(),
        mutation_call_id: call.into(),
        work_id: work_id.into(),
        disposition: DispositionStatus::Open,
        summary: "The current Turn could not confirm completion.".into(),
        action_updates: Some(vec![]),
        remaining_actions: Some(vec![]),
        next_condition: Some("Record the Work disposition again.".into()),
        evidence_refs: Some(vec![]),
        followups: Some(vec![]),
        backfill_tool_call_ids: None,
        expected_material_fingerprint: Some(expected),
        runtime_owned_open_generation: Some(RuntimeOwnedOpenGeneration { version: 1 }),
    }
}

/// An open Work in execution whose Turn has one completed, still unattached
/// tool result; returns the service and the Work id.
async fn with_unattached_result(
    name: &str,
) -> (
    crate::btcc::storage::testing::Fixture,
    crate::btcc::storage::BtccStorage,
    DurableWorkService,
    String,
) {
    let (fixture, storage, service, journal) = opened(name).await;
    let started = service
        .start_work(StartWorkInput {
            scope: scope(),
            mutation_call_id: "start".into(),
            objective: "finish the request".into(),
            backfill_tool_call_ids: None,
        })
        .await
        .unwrap();
    service.replace_plan(plan("plan")).await.unwrap();
    service
        .record_review(review("plan-review", ReviewSubject::Plan))
        .await
        .unwrap();
    journal_result(&journal, "tool-one", 1, 16).await;
    (fixture, storage, service, started.work_id)
}

#[tokio::test]
async fn own_attachment_of_completed_results_is_not_a_concurrent_change() {
    let (_fixture, storage, service, work_id) = with_unattached_result("work-cas-own").await;
    let read = service
        .bound_work_for_turn("turn".into())
        .await
        .unwrap()
        .unwrap();
    assert!(
        read.result_refs.is_empty(),
        "result attached before closeout"
    );
    let expected = disposition_material_fingerprint(&read).unwrap();
    let persisted = service
        .record_disposition(runtime_open("closeout", &work_id, expected))
        .await
        .unwrap();
    assert_eq!(persisted.status, WorkStatus::Open);
    assert_eq!(
        persisted.result_refs.len(),
        1,
        "command attached the result"
    );
    assert!(
        persisted
            .latest_disposition
            .as_ref()
            .is_some_and(|disposition| disposition.runtime_owned_open)
    );
    storage.close().await.unwrap();
}

#[tokio::test]
async fn material_changed_after_the_callers_read_is_rejected() {
    let (_fixture, storage, service, work_id) = with_unattached_result("work-cas-changed").await;
    let read = service
        .bound_work_for_turn("turn".into())
        .await
        .unwrap()
        .unwrap();
    let expected = disposition_material_fingerprint(&read).unwrap();
    // Another mutation changes the Work between the read and the closeout.
    service
        .record_checkpoint(CheckpointInput {
            scope: scope(),
            mutation_call_id: "checkpoint".into(),
            next_stage: None,
            action_updates: Some(vec![ActionProgress {
                action_key: "a".into(),
                status: ActionStatus::Done,
                note: None,
            }]),
            public_summary: Some("read complete".into()),
            next_step: None,
        })
        .await
        .unwrap();
    let error = service
        .record_disposition(runtime_open("closeout", &work_id, expected))
        .await
        .unwrap_err();
    assert_eq!(error.code(), "durable_work_material_changed");
    let unchanged = service
        .bound_work_for_turn("turn".into())
        .await
        .unwrap()
        .unwrap();
    assert!(unchanged.latest_disposition.is_none(), "{unchanged:?}");
    storage.close().await.unwrap();
}
