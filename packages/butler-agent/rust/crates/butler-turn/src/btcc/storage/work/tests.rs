use butler_core::json::JsonDocument;
use std::sync::Arc;

use serde_json::json;

use crate::btcc::TurnStore;
use crate::btcc::storage::{
    BtccRepositories, BtccStorage, ToolJournalFinish, ToolJournalFinishStatus,
    ToolJournalRepository, ToolJournalStart,
};
use crate::btcc::work::*;

use super::SessionWorkRepository;

pub(super) fn scope() -> WorkTurnScope {
    WorkTurnScope {
        turn_id: "turn".into(),
        session_id: "session".into(),
        project_ref: None,
    }
}

fn clock() -> Arc<dyn Fn() -> String + Send + Sync> {
    Arc::new(|| "2026-09-19T00:00:00.000Z".into())
}

pub(super) async fn opened(
    name: &str,
) -> (
    super::super::testing::Fixture,
    BtccStorage,
    DurableWorkService,
    ToolJournalRepository,
) {
    let fixture = super::super::testing::Fixture::activated();
    let storage = BtccStorage::open(fixture.config(name)).await.unwrap();
    let turns = BtccRepositories::new(storage.clone(), None);
    let (turn, fresh) = turns
        .load_or_admit(&super::super::testing::prepared())
        .await
        .unwrap();
    assert!(fresh);
    assert_eq!(turn.execution_fence, 0);
    let service = DurableWorkService::new(Arc::new(SessionWorkRepository::new(
        storage.clone(),
        clock(),
    )));
    let journal = ToolJournalRepository::new(storage.clone(), clock());
    (fixture, storage, service, journal)
}

pub(super) async fn journal_result(
    journal: &ToolJournalRepository,
    call: &str,
    index: usize,
    bytes: usize,
) {
    journal
        .start(ToolJournalStart {
            turn_id: "turn".into(),
            call_id: call.into(),
            tool_name: "read_file".into(),
            raw_arguments: "{}".into(),
            arguments: json!({}),
        })
        .await
        .unwrap();
    journal
        .finish(ToolJournalFinish {
            call_id: call.into(),
            status: ToolJournalFinishStatus::Completed,
            result: Some(
                JsonDocument::from_value(&json!({"index": index, "payload": "x".repeat(bytes)}))
                    .unwrap(),
            ),
            changed_files: None,
            error_code: None,
        })
        .await
        .unwrap();
}

pub(super) fn plan(call: &str) -> ReplacePlanInput {
    ReplacePlanInput {
        scope: scope(),
        mutation_call_id: call.into(),
        start_new: None,
        backfill_tool_call_ids: None,
        objective: "finish the request".into(),
        governing_refs: None,
        execution_mode: Some(ExecutionMode::Direct),
        actions: vec![PlanAction {
            action_key: "a".into(),
            description: "read then verify".into(),
            dependency_keys: vec![],
            effect: None,
        }],
        checks: vec!["verified".into()],
    }
}

pub(super) fn review(call: &str, subject: ReviewSubject) -> ReviewInput {
    ReviewInput {
        scope: scope(),
        mutation_call_id: call.into(),
        subject,
        verdict: ReviewVerdict::Accept,
        summary: "accepted".into(),
        corrections: vec![],
        action_updates: None,
        correction_scope: None,
        next_stage: None,
    }
}

/// Format pin: hashes used as ids in the store. Persisted content-ref hashes
/// across canonicalization edge cases, the SQLite identity's JavaScript
/// property order, and the source golden's relation identity and hash codec.
// test-category: format-pin
#[tokio::test]
async fn persisted_identity_hashes_are_stable() {
    crate::btcc::identity::tests::persisted_content_ref_hashes_are_stable_across_canonicalization_edge_cases();
    crate::btcc::identity::tests::sqlite_identity_uses_js_property_enumeration_order();
    source_golden_preserves_relation_identity_and_distinct_sqlite_hash_codec().await;
}

async fn source_golden_preserves_relation_identity_and_distinct_sqlite_hash_codec() {
    let expected: serde_json::Value =
        serde_json::from_str(include_str!("../../work/source-golden.json")).unwrap();
    let (_fixture, storage, service, _journal) = opened("work-golden").await;
    let started = service
        .start_work(StartWorkInput {
            scope: scope(),
            mutation_call_id: "start".into(),
            objective: "finish".into(),
            backfill_tool_call_ids: None,
        })
        .await
        .unwrap();
    assert_eq!(started.work_id, expected["workId"]);
    let (binding_id, request_hash): (String, String) = storage.execute(|db| {
        let binding = db.query_row("SELECT binding_revision_id FROM btcc_guided_turn_work_bindings WHERE turn_id = 'turn' AND is_current = 1", [], |row| row.get(0)).map_err(super::super::StorageError::sqlite)?;
        let hash = db.query_row("SELECT request_sha256 FROM btcc_guided_work_relation_commands WHERE mutation_call_id = 'start'", [], |row| row.get(0)).map_err(super::super::StorageError::sqlite)?;
        Ok((binding, hash))
    }).await.unwrap();
    assert_eq!(binding_id, expected["bindingId"]);
    assert_eq!(request_hash, expected["startHash"]);
    storage.close().await.unwrap();
}
