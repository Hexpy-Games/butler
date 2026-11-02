//! Durable Work fixtures for effect tests, shared with dependent crates'
//! scenario tests through the `test-support` feature.

use std::sync::Arc;

use serde_json::json;

use crate::btcc::TurnStore;
use crate::btcc::storage::{BtccRepositories, BtccStorage, SessionWorkRepository};
use crate::btcc::work::{
    DurableWorkService, ExecutionMode, PlanAction, ReplacePlanInput, ReviewInput, ReviewSubject,
    ReviewVerdict, StartWorkInput, WorkTurnScope, WorkView,
};

pub fn clock() -> Arc<dyn Fn() -> String + Send + Sync> {
    Arc::new(|| "2026-09-19T00:00:00.000Z".into())
}
pub(crate) fn scope() -> WorkTurnScope {
    WorkTurnScope {
        turn_id: "turn".into(),
        session_id: "session".into(),
        project_ref: None,
    }
}

pub async fn ready(
    name: &str,
) -> (
    crate::btcc::storage::testing::Fixture,
    BtccStorage,
    WorkView,
) {
    let fixture = crate::btcc::storage::testing::Fixture::activated();
    let storage = BtccStorage::open(fixture.config(name)).await.unwrap();
    BtccRepositories::new(storage.clone(), None)
        .load_or_admit(&crate::btcc::storage::testing::prepared())
        .await
        .unwrap();
    let service = DurableWorkService::new(Arc::new(SessionWorkRepository::new(
        storage.clone(),
        clock(),
    )));
    service
        .start_work(StartWorkInput {
            scope: scope(),
            mutation_call_id: "start-effect".into(),
            objective: "write reviewed file".into(),
            backfill_tool_call_ids: None,
        })
        .await
        .unwrap();
    service
        .replace_plan(ReplacePlanInput {
            scope: scope(),
            mutation_call_id: "plan-effect".into(),
            start_new: None,
            backfill_tool_call_ids: None,
            objective: "write reviewed file".into(),
            governing_refs: None,
            execution_mode: Some(ExecutionMode::Direct),
            actions: vec![PlanAction {
                action_key: "a".into(),
                description: "write".into(),
                dependency_keys: vec![],
                effect: Some(json!({"capability":"write_file","target":"workspace:a"})),
            }],
            checks: vec!["verify".into()],
        })
        .await
        .unwrap();
    let reviewed = service
        .record_review(ReviewInput {
            scope: scope(),
            mutation_call_id: "review-effect".into(),
            subject: ReviewSubject::Plan,
            verdict: ReviewVerdict::Accept,
            summary: "accepted".into(),
            corrections: vec![],
            action_updates: None,
            correction_scope: None,
            next_stage: None,
        })
        .await
        .unwrap();
    (fixture, storage, reviewed)
}
