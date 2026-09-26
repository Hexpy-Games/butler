use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::btcc::{
    AgentLoopProgress, BtccError, FinalArtifact, ModelIdentity, PortFuture, RuntimeTurnEventInput,
    TurnRecord,
};
use serde_json::{Value, json};

use super::ProductionAgentLoop;
use super::continuation::GuidedPresentation;
use super::contracts::*;
use super::guided_ports::TurnContextProjection;
use super::guided_ports::{GuidedInvocation, GuidedPolicyDependencies};
use super::operation_result_replay::{OperationResultMessageReferences, OperationResultScope};
use super::ports::*;
use super::test_data::tool;

pub(super) struct Fixture {
    pub model_results: Mutex<VecDeque<Result<ModelRoundResult, ModelRoundError>>>,
    pub tool_outputs: Mutex<HashMap<String, Value>>,
    pub events: Mutex<Vec<String>>,
    pub continuation_views: Mutex<Vec<(&'static str, Option<Value>)>>,
    pub request_history: Mutex<Vec<Vec<ModelRoundMessage>>>,
    pub request_contracts: Mutex<Vec<(Option<ToolChoice>, Option<u32>)>>,
    pub usage_attribution: Mutex<Option<UsageAttribution>>,
    pub progress_events: Mutex<Vec<RuntimeTurnEventInput>>,
    pub steering: Mutex<VecDeque<Vec<SteeringObservation>>>,
    pub candidates: Mutex<VecDeque<CandidateDisposition>>,
    pub batches: Mutex<VecDeque<BatchDisposition>>,
    pub outcomes: Mutex<HashMap<String, ToolOutcome>>,
    pub authority: Mutex<Option<AuthorityDecision>>,
    pub has_work: Mutex<bool>,
    pub rebase_once: Mutex<bool>,
    pub cancel_during_model: AtomicBool,
    pub cleanup_error: AtomicBool,
    pub operation_scopes: Mutex<Vec<OperationResultScope>>,
    pub result_references: Mutex<Vec<OperationResultMessageReferences>>,
}

impl Fixture {
    pub(super) fn new(results: impl IntoIterator<Item = ModelRoundResult>) -> Arc<Self> {
        Arc::new(Self {
            model_results: Mutex::new(results.into_iter().map(Ok).collect()),
            tool_outputs: Mutex::new(HashMap::new()),
            events: Mutex::new(Vec::new()),
            continuation_views: Mutex::new(Vec::new()),
            request_history: Mutex::new(Vec::new()),
            request_contracts: Mutex::new(Vec::new()),
            usage_attribution: Mutex::new(None),
            progress_events: Mutex::new(Vec::new()),
            steering: Mutex::new(VecDeque::new()),
            candidates: Mutex::new(VecDeque::new()),
            batches: Mutex::new(VecDeque::new()),
            outcomes: Mutex::new(HashMap::new()),
            authority: Mutex::new(None),
            has_work: Mutex::new(false),
            rebase_once: Mutex::new(false),
            cancel_during_model: AtomicBool::new(false),
            cleanup_error: AtomicBool::new(false),
            operation_scopes: Mutex::new(Vec::new()),
            result_references: Mutex::new(Vec::new()),
        })
    }

    pub(super) fn agent(self: &Arc<Self>) -> ProductionAgentLoop {
        ProductionAgentLoop {
            binding: super::LoopBinding::Fixture(super::fixture_binding::FixtureAgentLoop {
                model: self.clone(),
                execution_factory: self.clone(),
                policy: self.clone(),
                operation_result_factory: Arc::new(FixtureOperationFactory(self.clone())),
                work_scope: self.clone(),
                budget_factory: Arc::new(crate::btcc::GuidedContinuationBudgetFactory::new(
                    None,
                    Arc::new(|| 0),
                )),
                observer: Some(self.clone()),
            }),
        }
    }

    pub(super) fn guided_agent(
        self: &Arc<Self>,
        authority_decision: Option<AuthorityDecision>,
    ) -> ProductionAgentLoop {
        ProductionAgentLoop::guided(
            self.clone(),
            self.clone(),
            GuidedPolicyDependencies {
                prompt: self.clone(),
                authority: self.clone(),
                context: self.clone(),
                tools: self.clone(),
                journal: self.clone(),
                work: self.clone(),
                verified_image_payload: None,
                stream_observer: None,
                identity_observer: None,
            },
            authority_decision,
            Arc::new(FixtureOperationFactory(self.clone())),
            self.clone(),
            Arc::new(crate::btcc::GuidedContinuationBudgetFactory::new(
                None,
                Arc::new(|| 0),
            )),
            Some(self.clone()),
        )
    }

    fn note(&self, value: impl Into<String>) {
        self.events.lock().unwrap().push(value.into());
    }
}

impl ModelRoundPort for Fixture {
    fn run_round<'a>(
        &'a self,
        request: ModelRoundRequest<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<ModelRoundResult, ModelRoundError>> + Send + 'a>> {
        Box::pin(async move {
            self.continuation_views
                .lock()
                .unwrap()
                .push(("request", request.continuation.cloned()));
            self.request_history
                .lock()
                .unwrap()
                .push(request.messages.to_vec());
            self.request_contracts.lock().unwrap().push((
                request.tool_choice,
                request
                    .usage_attribution
                    .and_then(|value| value.round_index),
            ));
            if self.cancel_during_model.load(Ordering::SeqCst) {
                request.cancellation.cancel();
            }
            self.note(format!(
                "model:{}:{}:{}",
                request.round_id.unwrap_or("<generated>"),
                request
                    .messages
                    .last()
                    .map_or("", |value| value.content.as_ref()),
                request
                    .tools
                    .iter()
                    .map(|tool| tool.name.as_str())
                    .collect::<Vec<_>>()
                    .join(",")
            ));
            self.model_results.lock().unwrap().pop_front().unwrap()
        })
    }
}

mod replay_fixture;
pub(super) use replay_fixture::FixtureOperationFactory;

impl GuidedPolicyPort for Fixture {
    fn begin_context<'a>(
        &'a self,
        _: GuidedInvocation<'a>,
        _: Option<Arc<dyn crate::btcc::TurnContinuationBudgetPort>>,
    ) -> PortFuture<'a, Box<dyn TurnContextProjection + 'a>> {
        Box::pin(async move {
            Ok(Box::new(FixturePolicyContext(self)) as Box<dyn TurnContextProjection>)
        })
    }

    fn prepare<'a>(&'a self, invocation: GuidedInvocation<'a>) -> PortFuture<'a, PreparedPolicy> {
        Box::pin(async move {
            Ok(PreparedPolicy {
                prompt: invocation.turn.original_message.clone(),
                instructions: Some("guided".into()),
                tools: vec![
                    tool("read_file", false),
                    tool("web_search", true),
                    tool("start_work", true),
                ],
                tool_choice: Some(ToolChoice::Auto),
                route_context: None,
                authority_decision: self.authority.lock().unwrap().clone(),
                resumed_tool_call: None,
                max_output_tokens: None,
                attachments: vec![],
                image_carrier: None,
                image_capability: None,
                image_manifests: vec![],
                butler_data: Some("/tmp/butler".into()),
                usage_attribution: self.usage_attribution.lock().unwrap().clone(),
                cache_scope: Some(format!("btcc-guided:{}", invocation.turn.session_id)),
                stable_provider_cache_prefix: None,
                route_transport_attempt_ordinal: None,
                verified_image_payload: None,
                stream_observer: None,
                identity_observer: None,
                synthesize_after_tool_candidate: false,
                synthesize_after_tool_empty: false,
            })
        })
    }

    fn before_model_round<'a>(
        &'a self,
        _invocation: GuidedInvocation<'a>,
    ) -> PortFuture<'a, Vec<SteeringObservation>> {
        Box::pin(async move {
            Ok(self
                .steering
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_default())
        })
    }

    fn resolve_tools<'a>(
        &'a self,
        _invocation: GuidedInvocation<'a>,
        fallback: &'a [ModelRoundTool],
        final_report: bool,
    ) -> PortFuture<'a, (Vec<ModelRoundTool>, Option<String>)> {
        Box::pin(async move {
            self.note(if final_report {
                "surface:final"
            } else {
                "surface:ordinary"
            });
            Ok((
                if final_report {
                    vec![]
                } else {
                    fallback.to_vec()
                },
                Some("a".repeat(64)),
            ))
        })
    }

    fn prepare_context<'a>(
        &'a self,
        context: &'a dyn TurnContextProjection,
        _invocation: GuidedInvocation<'a>,
        input: ContextProjectionInput<'a>,
    ) -> ContextProjectionFuture<'a> {
        context.project(_invocation, input)
    }

    fn execute_tool<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        call: &'a ModelRoundToolCall,
        _: Option<u8>,
    ) -> Pin<
        Box<dyn Future<Output = Result<crate::json::JsonDocument, ToolExecutionError>> + Send + 'a>,
    > {
        Box::pin(async move {
            if invocation.cancellation.is_cancelled() {
                return Err(ToolExecutionError::Integrity(BtccError::new(
                    "turn_cancelled",
                    "turn_cancelled",
                )));
            }
            self.note(format!("execute:{}", call.name));
            crate::json::JsonDocument::from_value(
                &self
                    .tool_outputs
                    .lock()
                    .unwrap()
                    .get(&call.id)
                    .cloned()
                    .unwrap_or_else(|| json!({"value": call.id})),
            )
            .map_err(|error| {
                ToolExecutionError::Integrity(BtccError::new("tool_json", error.to_string()))
            })
        })
    }

    fn record_unexecuted<'a>(
        &'a self,
        _invocation: GuidedInvocation<'a>,
        call: &'a ModelRoundToolCall,
        _: &'a ToolResult,
    ) -> PortFuture<'a, ()> {
        Box::pin(async move {
            self.note(format!("unexecuted:{}", call.id));
            Ok(())
        })
    }

    fn assistant_before_tools<'a>(
        &'a self,
        _invocation: GuidedInvocation<'a>,
        _: &'a str,
        _: &'a [ModelRoundToolCall],
        _: u32,
    ) -> PortFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }

    fn after_tool_batch<'a>(
        &'a self,
        _invocation: GuidedInvocation<'a>,
        _: &'a [ModelRoundToolCall],
        results: &'a [ToolResult],
        _: u32,
    ) -> PortFuture<'a, BatchDisposition> {
        Box::pin(async move {
            self.note(format!(
                "batch:{}",
                results
                    .iter()
                    .map(|item| item.tool_call_id.as_str())
                    .collect::<Vec<_>>()
                    .join(",")
            ));
            Ok(self
                .batches
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(BatchDisposition::Continue))
        })
    }

    fn outcome_from_tool_result<'a>(
        &'a self,
        _invocation: GuidedInvocation<'a>,
        call: &'a ModelRoundToolCall,
        _: &'a ToolResult,
    ) -> PortFuture<'a, Option<ToolOutcome>> {
        Box::pin(async move { Ok(self.outcomes.lock().unwrap().get(&call.id).cloned()) })
    }

    fn review_final_candidate<'a>(
        &'a self,
        _invocation: GuidedInvocation<'a>,
        text: &'a str,
        _: u32,
    ) -> PortFuture<'a, CandidateDisposition> {
        Box::pin(async move {
            Ok(self
                .candidates
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| CandidateDisposition::Accepted(Some(text.into()))))
        })
    }

    fn handle_text_tool_calls<'a>(
        &'a self,
        _invocation: GuidedInvocation<'a>,
        _: &'a [String],
        _: &'a [ModelRoundToolCall],
        _: &'a str,
        _: u32,
    ) -> PortFuture<'a, TextCallDisposition> {
        Box::pin(async {
            Ok(TextCallDisposition::Continue(
                "structured tool calls required".into(),
            ))
        })
    }

    fn synthesize_final<'a>(
        &'a self,
        _invocation: GuidedInvocation<'a>,
        _: &'a [ModelRoundMessage],
        _: u32,
    ) -> PortFuture<'a, String> {
        Box::pin(async { Ok("synthesized".into()) })
    }

    fn accept_tool_candidate<'a>(
        &'a self,
        _invocation: GuidedInvocation<'a>,
        _: &'a str,
    ) -> PortFuture<'a, bool> {
        Box::pin(async { Ok(false) })
    }

    fn operation_result_call_id(&self, provider_call_id: &str) -> Option<String> {
        Some(format!("journal-{provider_call_id}"))
    }
    fn tool_result_message<'a>(
        &'a self,
        _: &'a TurnRecord,
        result: &'a ToolResult,
        references: &'a OperationResultMessageReferences,
    ) -> PortFuture<'a, ModelRoundMessage> {
        Box::pin(async move {
            Ok(ModelRoundMessage {
                role: ModelRoundRole::Tool,
                content: serde_json::to_string(result).unwrap().into(),
                tool_call_id: Some(result.tool_call_id.clone()),
                name: Some(result.name.clone()),
                tool_calls: None,
                image_attachments: vec![],
                provider_data: None,
                request_segment_kind: Some("latest_tool_result_delivery".into()),
                operation_result_reference: references.reference.clone(),
                operation_result_call_id: references.operation_result_call_id.clone(),
                continuation_item_id: None,
            })
        })
    }
    fn presentation<'a>(
        &'a self,
        _: GuidedInvocation<'a>,
    ) -> PortFuture<'a, Option<GuidedPresentation>> {
        Box::pin(async { Ok(None) })
    }
    fn closeout<'a>(
        &'a self,
        _invocation: GuidedInvocation<'a>,
        input: CloseoutInput<'a>,
    ) -> PortFuture<'a, GuidedCloseout> {
        Box::pin(async move {
            Ok(GuidedCloseout {
                content: input.content.into(),
                work_status: None,
                accepted_work_result: None,
                runtime_failure: None,
                artifacts: Vec::<FinalArtifact>::new(),
                changed_files: vec![],
                plan: None,
                model_identity: Some(ModelIdentity {
                    requested_model_ref: "openai/model".into(),
                    effective_model_ref: "openai/model".into(),
                    provider_reported_model_ref: None,
                }),
                has_final_work: *self.has_work.lock().unwrap(),
            })
        })
    }
}

impl AgentLoopObserver for Fixture {
    fn event(&self, event: &AgentLoopEvent) {
        self.note(format!("event:{event:?}"));
    }
}

impl AgentLoopProgress for Fixture {
    fn emit(&self, event: RuntimeTurnEventInput) -> PortFuture<'_, ()> {
        Box::pin(async move {
            self.note(format!("progress:{}", event.kind));
            self.progress_events.lock().unwrap().push(event);
            Ok(())
        })
    }
}

struct FixturePolicyContext<'a>(&'a Fixture);

impl TurnContextProjection for FixturePolicyContext<'_> {
    fn project<'a>(
        &'a self,
        _: GuidedInvocation<'a>,
        _: ContextProjectionInput<'a>,
    ) -> ContextProjectionFuture<'a> {
        Box::pin(async move {
            Ok(ContextProjection {
                messages: ContextMessages::Transport,
                bounded_continuation: None,
                provider_body_admission: None,
                requires_rebase: std::mem::take(&mut *self.0.rebase_once.lock().unwrap()),
                recheck_steering_on_rebase: true,
            })
        })
    }
}
