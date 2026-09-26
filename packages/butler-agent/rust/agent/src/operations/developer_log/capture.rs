use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use crate::btcc::{
    AgentLoopError, AgentLoopResult, ModelRoundError, ModelRoundObserver, ModelRoundRequest,
    ModelRoundResult, TurnDeveloperLogCapturePort, TurnDeveloperLogExecution,
    TurnDeveloperLogFuture, TurnRecord,
};

use super::store::DeveloperLogStore;
mod entry;
mod snapshot;

use entry::terminal_entry;
use snapshot::{
    FailureSnapshot, RequestSnapshot, ResponseSnapshot, failure_snapshot, request_snapshot,
    response_snapshot,
};

pub(crate) trait DeveloperDiagnosticsSettingsPort: Send + Sync {
    fn enabled(&self) -> Pin<Box<dyn Future<Output = bool> + Send + '_>>;
}

pub(crate) struct OperationsDeveloperLogCapture {
    store: Arc<DeveloperLogStore>,
    settings: Arc<dyn DeveloperDiagnosticsSettingsPort>,
}

impl OperationsDeveloperLogCapture {
    pub(crate) fn new(
        store: Arc<DeveloperLogStore>,
        settings: Arc<dyn DeveloperDiagnosticsSettingsPort>,
    ) -> Self {
        Self { store, settings }
    }
}

impl TurnDeveloperLogCapturePort for OperationsDeveloperLogCapture {
    fn start_execution(&self) -> Box<dyn TurnDeveloperLogExecution> {
        Box::new(ExecutionCapture {
            store: self.store.clone(),
            settings: self.settings.clone(),
            state: Mutex::new(CaptureState::default()),
        })
    }
}

#[derive(Default)]
struct CaptureState {
    request: Option<RequestSnapshot>,
    response: Option<ResponseSnapshot>,
    failure: Option<FailureSnapshot>,
    round_count: u64,
}

struct ExecutionCapture {
    store: Arc<DeveloperLogStore>,
    settings: Arc<dyn DeveloperDiagnosticsSettingsPort>,
    state: Mutex<CaptureState>,
}

impl ModelRoundObserver for ExecutionCapture {
    fn request<'a>(&'a self, request: &'a ModelRoundRequest<'_>) -> TurnDeveloperLogFuture<'a> {
        Box::pin(async move {
            {
                let mut state = self.lock_state();
                state.round_count = state.round_count.saturating_add(1);
                state.request = None;
                state.response = None;
                state.failure = None;
            }
            if !self.settings.enabled().await {
                return;
            }
            if let Some(snapshot) = request_snapshot(request) {
                self.lock_state().request = Some(snapshot);
            }
        })
    }

    fn response<'a>(&'a self, response: &'a ModelRoundResult) -> TurnDeveloperLogFuture<'a> {
        Box::pin(async move {
            if !self.settings.enabled().await {
                return;
            }
            let mut state = self.lock_state();
            if state.request.is_some() {
                state.response = Some(response_snapshot(response));
            }
        })
    }

    fn failure<'a>(&'a self, error: &'a ModelRoundError) -> TurnDeveloperLogFuture<'a> {
        Box::pin(async move {
            if !self.settings.enabled().await {
                return;
            }
            let mut state = self.lock_state();
            if state.request.is_some() && state.failure.is_none() {
                state.failure = Some(failure_snapshot(error));
            }
        })
    }
}

impl TurnDeveloperLogExecution for ExecutionCapture {
    fn capture<'a>(
        &'a self,
        turn: &'a TurnRecord,
        result: Result<&'a AgentLoopResult, &'a AgentLoopError>,
    ) -> TurnDeveloperLogFuture<'a> {
        Box::pin(async move {
            let state = std::mem::take(&mut *self.lock_state());
            let enabled = self.settings.enabled().await;
            let entry = enabled
                .then(|| terminal_entry(turn, result, &state))
                .flatten();
            drop(state);
            if let Some(entry) = entry {
                let store = self.store.clone();
                let _ = tokio::task::spawn_blocking(move || store.append(&entry)).await;
            }
        })
    }
}

impl ExecutionCapture {
    fn lock_state(&self) -> std::sync::MutexGuard<'_, CaptureState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}
