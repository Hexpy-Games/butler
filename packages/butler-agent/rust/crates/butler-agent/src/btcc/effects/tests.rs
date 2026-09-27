use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use super::EffectService;
use super::contracts::*;
use super::testing::{clock, ready, scope};
use super::{identity, outcomes, recovery};
use crate::btcc::TurnStore;
use crate::btcc::storage::{
    BtccRepositories, BtccStorage, SessionWorkRepository, StorageEffectJournal,
    ToolJournalRepository, ToolJournalStart,
};
use crate::btcc::work::{
    DurableWorkService, ExecutionMode, PlanAction, ReplacePlanInput, ReviewInput, ReviewSubject,
    ReviewVerdict, StartWorkInput, WorkView,
};
use tokio_util::sync::CancellationToken;

struct FixtureAdapter {
    calls: Arc<AtomicUsize>,
    result: butler_core::json::JsonDocument,
    binding: PlanBinding,
}
impl EffectAdapter for FixtureAdapter {
    fn capability(&self) -> &'static str {
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
