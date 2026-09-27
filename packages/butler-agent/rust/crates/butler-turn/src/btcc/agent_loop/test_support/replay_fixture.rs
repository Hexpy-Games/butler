use std::sync::Arc;

use serde_json::Value;

use crate::btcc::{BtccError, PortFuture, StateExecutionClaim, TurnRecord};

use super::super::contracts::{ModelRoundMessage, ModelRoundResult, ReplayPreparation};
use super::super::operation_result_replay::{
    OperationResultFuture, OperationResultMessageReferences, OperationResultRuntime,
    OperationResultRuntimeFactory, OperationResultScope, TurnWorkScopePort,
};
use super::super::ports::ModelRoundPort;
use super::Fixture;

impl OperationResultRuntime for Fixture {
    fn prepare<'a>(
        &'a self,
        round_id: &'a str,
        _: &'a [ModelRoundMessage],
        _: &'a dyn ModelRoundPort,
        _: Option<&'a str>,
    ) -> OperationResultFuture<'a, ReplayPreparation> {
        Box::pin(async move {
            self.note(format!("prepare:{round_id}"));
            Ok(ReplayPreparation { messages: None })
        })
    }

    fn accepted<'a>(
        &'a self,
        round_id: &'a str,
        response: &'a ModelRoundResult,
    ) -> OperationResultFuture<'a, ()> {
        Box::pin(async move {
            self.continuation_views
                .lock()
                .unwrap()
                .push(("accepted", response.continuation.clone()));
            self.note(format!("accepted:{round_id}"));
            Ok(())
        })
    }

    fn failed<'a>(&'a self, round_id: &'a str) -> OperationResultFuture<'a, ()> {
        Box::pin(async move {
            self.note(format!("failed:{round_id}"));
            if self.cleanup_error.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(
                    super::super::operation_result_replay::OperationResultError::Contract(
                        BtccError::relayed("cleanup_failed", "cleanup_failed"),
                    ),
                );
            }
            Ok(())
        })
    }

    fn read_tool<'a>(&'a self, _: &'a serde_json::Map<String, Value>) -> PortFuture<'a, Value> {
        Box::pin(async { Ok(Value::Null) })
    }
    fn list_tool<'a>(&'a self, _: &'a serde_json::Map<String, Value>) -> PortFuture<'a, Value> {
        Box::pin(async { Ok(Value::Null) })
    }
    fn references_for_call<'a>(
        &'a self,
        _: &'a str,
        _: Option<&'a str>,
    ) -> PortFuture<'a, OperationResultMessageReferences> {
        Box::pin(async { Ok(OperationResultMessageReferences::default()) })
    }
}

pub(in crate::btcc::agent_loop) struct FixtureOperationFactory(
    pub(in crate::btcc::agent_loop) Arc<Fixture>,
);

impl OperationResultRuntimeFactory for FixtureOperationFactory {
    fn bind(
        &self,
        scope: OperationResultScope,
    ) -> Result<Option<Arc<dyn OperationResultRuntime>>, BtccError> {
        self.0.operation_scopes.lock().unwrap().push(scope);
        Ok(Some(self.0.clone()))
    }
}

impl TurnWorkScopePort for Fixture {
    fn initial_work_id<'a>(
        &'a self,
        _: &'a TurnRecord,
        _: &'a StateExecutionClaim,
    ) -> PortFuture<'a, Option<String>> {
        Box::pin(async { Ok(None) })
    }
}
