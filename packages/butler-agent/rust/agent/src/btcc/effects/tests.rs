use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use super::NativeEffectService;
use super::contracts::*;
use super::{identity, outcomes, recovery};
use crate::btcc::TurnStore;
use crate::btcc::storage::{
    BtccRepositories, BtccStorage, SessionWorkRepository, StorageEffectJournal,
    ToolJournalRepository, ToolJournalStart,
};
use crate::btcc::work::{
    DurableWorkService, ExecutionMode, PlanAction, ReplacePlanInput, ReviewInput, ReviewSubject,
    ReviewVerdict, StartWorkInput, WorkTurnScope, WorkView,
};
use tokio_util::sync::CancellationToken;

struct FixtureAdapter {
    calls: Arc<AtomicUsize>,
    result: crate::json::JsonDocument,
    binding: PlanBinding,
}
impl EffectAdapter for FixtureAdapter {
    fn capability(&self) -> &str {
        "write_file"
    }
    fn binding(&self) -> PlanBinding {
        self.binding
    }
    fn normalize_target(&self, target: &str) -> EffectResult<String> {
        Ok(target.into())
    }
    fn sanitize_target(&self, target: &str) -> EffectResult<String> {
        Ok(target.into())
    }
    fn normalize_input(&self, input: &serde_json::Value) -> EffectResult<serde_json::Value> {
        Ok(input.clone())
    }
    fn classify<'a>(
        &'a self,
        blocker: &'a EffectBlocker,
        _target: &'a str,
        _input: &'a serde_json::Value,
    ) -> Option<EffectFuture<'a, BlockerRelation>> {
        let relation = match blocker.target.as_str() {
            "workspace:a" => BlockerRelation::Equivalent,
            "workspace:b" => BlockerRelation::Overlapping,
            "ambiguous" => BlockerRelation::Ambiguous,
            _ => BlockerRelation::Unrelated,
        };
        Some(Box::pin(async move { Ok(relation) }))
    }
    fn dispatch<'a>(
        &'a self,
        _target: &'a str,
        _input: &'a serde_json::Value,
        _key: &'a str,
        _signal: &'a CancellationToken,
    ) -> EffectFuture<'a, AdapterOutcome> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(AdapterOutcome::Applied(self.result.clone()))
        })
    }
    fn reconcile<'a>(
        &'a self,
        _target: &'a str,
        _input: &'a serde_json::Value,
        _key: &'a str,
        _signal: &'a CancellationToken,
        attempts: i64,
        _prior: Option<&'a EffectError>,
    ) -> EffectFuture<'a, AdapterOutcome> {
        Box::pin(async move {
            Ok(if attempts == 0 {
                AdapterOutcome::NotApplied(EffectAdapterError::new("not_applied", "not yet"))
            } else {
                AdapterOutcome::Applied(self.result.clone())
            })
        })
    }
}
fn clock() -> Arc<dyn Fn() -> String + Send + Sync> {
    Arc::new(|| "2026-09-19T00:00:00.000Z".into())
}
fn scope() -> WorkTurnScope {
    WorkTurnScope {
        turn_id: "turn".into(),
        session_id: "session".into(),
        project_ref: None,
    }
}

async fn ready(name: &str) -> (crate::btcc::storage::tests::Fixture, BtccStorage, WorkView) {
    let fixture = crate::btcc::storage::tests::Fixture::activated();
    let storage = BtccStorage::open(fixture.config(name)).await.unwrap();
    BtccRepositories::new(storage.clone(), None)
        .load_or_admit(&crate::btcc::storage::transition_tests::prepared())
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

fn invocation(
    work: WorkView,
    adapter: Arc<dyn EffectAdapter>,
    signal: CancellationToken,
) -> ExecuteEffect {
    ExecuteEffect {
        work,
        access: Access::Full,
        occurrence_id: Some("effect-call".into()),
        signal,
        target: "workspace:a".into(),
        input: json!({"path":"a","content":"x"}),
        adapter,
    }
}

struct CancelAtMarker(CancellationToken);
impl EffectFaultHook for CancelAtMarker {
    fn reached<'a>(
        &'a self,
        point: &'static str,
        _identity: &'a EffectIdentity,
    ) -> EffectFuture<'a, ()> {
        if point == "after_dispatch_marker" {
            self.0.cancel();
        }
        Box::pin(async { Ok(()) })
    }
}

struct FailAt(&'static str);
impl EffectFaultHook for FailAt {
    fn reached<'a>(
        &'a self,
        point: &'static str,
        _identity: &'a EffectIdentity,
    ) -> EffectFuture<'a, ()> {
        let fail = point == self.0;
        Box::pin(async move {
            if fail {
                Err(EffectFailure::adapter("fixture replacement"))
            } else {
                Ok(())
            }
        })
    }
}

mod flow;
mod journal;
mod oracle;
mod write_adapter;
