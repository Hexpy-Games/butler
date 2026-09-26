use parking_lot::Mutex;
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

use tokio::sync::Mutex as AsyncMutex;

use crate::btcc::agent_loop::ModelRoundPort;
use crate::btcc::{BtccError, ModelIdentity, ReasoningEffort, TurnStore};

use super::contracts::{
    ModelExecution, ModelExecutionFactory, ModelExecutionInput, ModelExecutionView,
    ModelRouteRetryConfig, RouteState,
};
use super::support::{selected, validate};
use super::{hooks::RouteHooks, routed::RoutedRound};
use crate::btcc::BtccCode;

pub(crate) struct TurnModelExecutionFactory {
    store: Arc<dyn TurnStore>,
    retry: ModelRouteRetryConfig,
}

impl TurnModelExecutionFactory {
    pub(crate) fn new(store: Arc<dyn TurnStore>, retry: ModelRouteRetryConfig) -> Self {
        Self { store, retry }
    }
}

impl ModelExecutionFactory for TurnModelExecutionFactory {
    fn create<'a>(
        &self,
        input: ModelExecutionInput<'a>,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<Box<dyn ModelExecution + 'a>, BtccError>>
                + Send
                + 'a,
        >,
    > {
        let store = self.store.clone();
        let retry = self.retry;
        Box::pin(async move {
            let selected = selected(&input.turn.model_selection)?;
            let source_revision = input.source_revision;
            let Some(value) = &input.turn.model_route else {
                return Ok(Box::new(PassthroughExecution {
                    base: input.base,
                    active: selected.0,
                    reasoning: selected.1,
                }) as Box<dyn ModelExecution>);
            };
            let route: RouteState = serde_json::from_value(value.clone()).map_err(|source| {
                BtccError::detected(BtccCode::ModelRouteInvalid, "invalid admitted model route")
                    .with_source(source)
            })?;
            validate(&route)?;
            let candidate = route
                .candidates
                .get(route.active_cursor as usize)
                .cloned()
                .ok_or_else(|| {
                    BtccError::detected(
                        BtccCode::ModelRouteExhausted,
                        "model route has no active candidate",
                    )
                })?;
            let hooks = RouteHooks::new(
                store,
                input.turn,
                input.claim,
                value.clone(),
                route.route_digest.clone(),
            );
            Ok(Box::new(RoutedExecution {
                base: input.base,
                runner: RoutedRound {
                    base: input.base,
                    turn_id: &input.turn.turn_id,
                    route: AsyncMutex::new(route),
                    hooks,
                    progress: input.progress,
                    model_round_observer: input.model_round_observer,
                    cancellation: input.cancellation,
                    retry,
                    semantic_state: input.turn.semantic_state,
                    view: ViewState::new(
                        candidate.model_ref.clone(),
                        candidate.reasoning_effort.clone(),
                        source_revision,
                    ),
                },
            }) as Box<dyn ModelExecution>)
        })
    }
}

pub(super) struct ViewState {
    pub(super) active: Mutex<String>,
    selected_reasoning: ReasoningEffort,
    pub(super) accepted: Mutex<Option<ModelIdentity>>,
    pub(super) pending_fallback: Mutex<Option<(String, String)>>,
    source_revision: super::GuidedSourceRevision,
    generated_round_sequence: AtomicU64,
}

impl ViewState {
    pub(super) fn new(
        model: String,
        reasoning: ReasoningEffort,
        source_revision: super::GuidedSourceRevision,
    ) -> Self {
        Self {
            active: Mutex::new(model),
            selected_reasoning: reasoning,
            accepted: Mutex::new(None),
            pending_fallback: Mutex::new(None),
            source_revision,
            generated_round_sequence: AtomicU64::new(0),
        }
    }

    pub(super) fn next_source_revision(&self) -> u64 {
        self.source_revision.next()
    }

    pub(super) fn next_generated_round_id(&self, turn_id: &str) -> String {
        let sequence = self
            .generated_round_sequence
            .fetch_add(1, Ordering::Relaxed);
        format!("{turn_id}:round:{sequence}")
    }
}

struct RoutedExecution<'a> {
    base: &'a dyn ModelRoundPort,
    runner: RoutedRound<'a>,
}

impl ModelExecutionView for RoutedExecution<'_> {
    fn active_model_ref(&self) -> String {
        self.runner.view.active.lock().clone()
    }
    fn selected_reasoning_effort(&self) -> ReasoningEffort {
        self.runner.view.selected_reasoning.clone()
    }
    fn accepted_model_identity(&self) -> Option<ModelIdentity> {
        self.runner.view.accepted.lock().clone()
    }
}
impl ModelExecution for RoutedExecution<'_> {
    fn routed(&self) -> &dyn ModelRoundPort {
        &self.runner
    }
    fn base(&self) -> &dyn ModelRoundPort {
        self.base
    }
}

struct PassthroughExecution<'a> {
    base: &'a dyn ModelRoundPort,
    active: String,
    reasoning: ReasoningEffort,
}
impl ModelExecutionView for PassthroughExecution<'_> {
    fn active_model_ref(&self) -> String {
        self.active.clone()
    }
    fn selected_reasoning_effort(&self) -> ReasoningEffort {
        self.reasoning.clone()
    }
    fn accepted_model_identity(&self) -> Option<ModelIdentity> {
        None
    }
}

impl ModelExecution for PassthroughExecution<'_> {
    fn routed(&self) -> &dyn ModelRoundPort {
        self.base
    }
    fn base(&self) -> &dyn ModelRoundPort {
        self.base
    }
}
