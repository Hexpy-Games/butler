use crate::json::JsonDocument;
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
    super::super::tests::Fixture,
    BtccStorage,
    DurableWorkService,
    ToolJournalRepository,
) {
    let fixture = super::super::tests::Fixture::activated();
    let storage = BtccStorage::open(fixture.config(name)).await.unwrap();
    let turns = BtccRepositories::new(storage.clone(), None);
    let (turn, fresh) = turns
        .load_or_admit(&super::super::transition_tests::prepared())
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

#[tokio::test]
async fn real_admission_plan_journal_review_disposition_and_reopen_share_one_owner() {
    let (fixture, storage, service, journal) = opened("work-lifecycle").await;
    let started = service
        .start_work(StartWorkInput {
            scope: scope(),
            mutation_call_id: "start".into(),
            objective: "finish the request".into(),
            backfill_tool_call_ids: None,
        })
        .await
        .unwrap();
    assert_eq!(started.status, WorkStatus::Open);
    assert_eq!(started.work_id, super::common::record_id("work", "start"));
    assert_eq!(
        service
            .bound_work_for_turn("turn".into())
            .await
            .unwrap()
            .unwrap()
            .work_id,
        started.work_id
    );
    let planned = service.replace_plan(plan("plan")).await.unwrap();
    assert_eq!(planned.current_stage, Some(WorkStage::Planning));
    assert_eq!(planned.current_plan.as_ref().unwrap().revision, 1);
    let plan_replay = service.replace_plan(plan("plan")).await.unwrap();
    assert_eq!(
        plan_replay.current_plan.unwrap().plan_revision_id,
        planned.current_plan.as_ref().unwrap().plan_revision_id
    );
    assert_eq!(
        service
            .record_review(review("plan-review", ReviewSubject::Plan))
            .await
            .unwrap()
            .current_stage,
        Some(WorkStage::Execution)
    );
    journal_result(&journal, "tool-one", 1, 16).await;
    let first_backfill = service
        .continue_work(ContinueWorkInput {
            scope: scope(),
            mutation_call_id: "continue-one".into(),
            work_id: started.work_id.clone(),
            backfill_tool_call_ids: Some(vec!["tool-one".into()]),
        })
        .await
        .unwrap();
    assert_eq!(first_backfill.result_refs.len(), 1);
    journal_result(&journal, "tool-two", 2, 16).await;
    let second_backfill = service
        .continue_work(ContinueWorkInput {
            scope: scope(),
            mutation_call_id: "continue-two".into(),
            work_id: started.work_id.clone(),
            backfill_tool_call_ids: Some(vec!["tool-two".into()]),
        })
        .await
        .unwrap();
    assert_eq!(second_backfill.result_refs.len(), 2);
    let checked = service
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
    assert_eq!(checked.action_progress[0].status, ActionStatus::Done);
    let result_review = service
        .record_review(review("result-review", ReviewSubject::Result))
        .await
        .unwrap();
    assert_eq!(result_review.current_stage, Some(WorkStage::Validation));
    let validation = service
        .record_review(review("completion-review", ReviewSubject::Completion))
        .await
        .unwrap();
    assert_eq!(validation.current_stage, Some(WorkStage::Reporting));
    assert_eq!(
        validation.status,
        WorkStatus::Open,
        "review is not closeout authority"
    );
    let disposition = DispositionInput {
        scope: scope(),
        mutation_call_id: "disposition".into(),
        work_id: started.work_id.clone(),
        disposition: DispositionStatus::Completed,
        summary: "complete".into(),
        action_updates: None,
        remaining_actions: None,
        next_condition: None,
        evidence_refs: None,
        followups: None,
        backfill_tool_call_ids: None,
        expected_material_fingerprint: None,
        runtime_owned_open_generation: None,
    };
    let work_id = started.work_id.clone();
    storage.execute(move |db| {
        db.execute("INSERT INTO btcc_guided_work_effect_blockers
            (blocker_id, source_turn_id, source_occurrence_id, session_id, work_id,
             capability, target, input_json, input_sha256, idempotency_key, detail, status, created_at)
            VALUES ('blocker', 'turn', 'occurrence', 'session', ?1,
            'shell', 'target', '{}', 'hash', 'key', 'unresolved', 'unresolved', 'now')",
            [&work_id]).map_err(super::super::StorageError::sqlite)?;
        Ok(())
    }).await.unwrap();
    let blocked = service
        .record_disposition(disposition.clone())
        .await
        .unwrap_err();
    assert_eq!(blocked.code(), "durable_work_effect_blocker");
    storage
        .execute(|db| {
            db.execute(
                "DELETE FROM btcc_guided_work_effect_blockers WHERE blocker_id = 'blocker'",
                [],
            )
            .map_err(super::super::StorageError::sqlite)?;
            Ok(())
        })
        .await
        .unwrap();
    let work_id = started.work_id.clone();
    let plan_id = planned
        .current_plan
        .as_ref()
        .unwrap()
        .plan_revision_id
        .clone();
    storage
        .execute(move |db| {
            db.execute(
                "INSERT INTO btcc_guided_effects
            (effect_id, receipt_id, idempotency_key, identity_sha256, request_sha256,
             input_sha256, target_sha256, work_id, plan_revision_id, action_key, capability,
             sanitized_target, status, journal_revision, dispatch_attempts, created_at, updated_at)
             VALUES ('effect', 'receipt', 'effect-key', 'identity', 'request', 'input',
             'target', ?1, ?2, 'a', 'shell', 'target', 'prepared', 1, 0, 'now', 'now')",
                rusqlite::params![work_id, plan_id],
            )
            .map_err(super::super::StorageError::sqlite)?;
            Ok(())
        })
        .await
        .unwrap();
    let pending = service
        .record_disposition(disposition.clone())
        .await
        .unwrap_err();
    assert_eq!(pending.code(), "durable_work_pending_effect");
    storage
        .execute(|db| {
            db.execute(
                "DELETE FROM btcc_guided_effects WHERE effect_id = 'effect'",
                [],
            )
            .map_err(super::super::StorageError::sqlite)?;
            Ok(())
        })
        .await
        .unwrap();
    let completed = service.record_disposition(disposition).await.unwrap();
    assert_eq!(completed.status, WorkStatus::Completed);
    assert_eq!(
        completed
            .latest_disposition
            .as_ref()
            .unwrap()
            .evidence_snapshot,
        second_backfill
            .result_refs
            .iter()
            .map(|reference| reference.result_ref.clone())
            .collect::<Vec<_>>()
    );
    assert!(
        service
            .claim_closeout_correction(ClaimCloseoutCorrectionInput {
                scope: scope(),
                work_id: started.work_id.clone()
            })
            .await
            .unwrap()
    );
    assert!(
        !service
            .claim_closeout_correction(ClaimCloseoutCorrectionInput {
                scope: scope(),
                work_id: started.work_id.clone()
            })
            .await
            .unwrap()
    );
    storage.close().await.unwrap();
    let reopened_storage = BtccStorage::open(fixture.config("work-lifecycle"))
        .await
        .unwrap();
    let reopened_service = DurableWorkService::new(Arc::new(SessionWorkRepository::new(
        reopened_storage.clone(),
        clock(),
    )));
    let persisted = reopened_service
        .bound_work_for_turn("turn".into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(persisted.work_id, started.work_id);
    assert_eq!(persisted.status, WorkStatus::Completed);
    assert_eq!(persisted.result_refs.len(), 2);
    reopened_storage.close().await.unwrap();
}

#[tokio::test]
async fn context_hydrates_only_ordered_last_fifty_large_result_bodies() {
    let (_fixture, storage, service, journal) = opened("work-context-tail").await;
    let mut call_ids = Vec::new();
    for index in 0..51 {
        let call = format!("tool-{index}");
        journal_result(&journal, &call, index, 16_384).await;
        call_ids.push(call);
    }
    service
        .start_work(StartWorkInput {
            scope: scope(),
            mutation_call_id: "start-tail".into(),
            objective: "collect".into(),
            backfill_tool_call_ids: Some(call_ids),
        })
        .await
        .unwrap();
    storage
        .execute(|db| {
            db.execute(
                "UPDATE btcc_guided_work_results SET source_turn_rowid = NULL,
            source_turn_sequence = NULL WHERE tool_call_id IN ('tool-0', 'tool-50')",
                [],
            )
            .map_err(super::super::StorageError::sqlite)?;
            db.execute(
                "UPDATE btcc_guided_work_results SET source_turn_rowid = 1,
            source_turn_sequence = NULL WHERE tool_call_id IN ('tool-1', 'tool-2')",
                [],
            )
            .map_err(super::super::StorageError::sqlite)?;
            db.execute(
                "UPDATE btcc_guided_work_results SET source_turn_rowid = 1,
            source_turn_sequence = 1 WHERE tool_call_id IN ('tool-3', 'tool-4')",
                [],
            )
            .map_err(super::super::StorageError::sqlite)?;
            Ok(())
        })
        .await
        .unwrap();
    let source_tail: Vec<String> = storage
        .execute(|db| {
            let mut statement = db
                .prepare(
                    "SELECT result_ref FROM btcc_guided_work_results result
            ORDER BY CASE WHEN result.source_turn_rowid IS NULL THEN 1 ELSE 0 END,
              result.source_turn_rowid,
              CASE WHEN result.source_turn_sequence IS NULL THEN 1 ELSE 0 END,
              result.source_turn_sequence, result.sequence, result.rowid",
                )
                .map_err(super::super::StorageError::sqlite)?;
            let all = statement
                .query_map([], |row| row.get(0))
                .map_err(super::super::StorageError::sqlite)?
                .collect::<Result<Vec<String>, _>>()
                .map_err(super::super::StorageError::sqlite)?;
            Ok(all.into_iter().skip(1).collect())
        })
        .await
        .unwrap();
    let context = service.load_context(scope()).await.unwrap().unwrap();
    assert_eq!(context.work.result_refs.len(), 51);
    assert_eq!(context.result_facts.len(), 50);
    assert_eq!(
        context
            .result_facts
            .iter()
            .map(|fact| fact.result_ref.clone().unwrap())
            .collect::<Vec<_>>(),
        source_tail
    );
    storage.close().await.unwrap();
}

#[tokio::test]
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
