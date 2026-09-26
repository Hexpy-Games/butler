use std::pin::Pin;

use crate::btcc::{PortFuture, TurnRecord};

use super::continuation::GuidedPresentation;
use super::contracts::{
    BatchDisposition, CandidateDisposition, CloseoutInput, ContextProjectionInput, GuidedCloseout,
    ModelRoundMessage, ModelRoundTool, ModelRoundToolCall, PreparedPolicy, SteeringObservation,
    TextCallDisposition, ToolOutcome, ToolResult,
};
use super::guided_ports::{GuidedInvocation, GuidedPolicyDependencies};
use super::ports::{ContextProjectionFuture, GuidedPolicyPort, ToolExecutionError};
use crate::btcc::BtccCode;
pub(super) struct GuidedPolicy {
    dependencies: GuidedPolicyDependencies,
    authority_decision: Option<super::contracts::AuthorityDecision>,
}

impl GuidedPolicy {
    #[cfg(test)]
    pub(super) fn new(
        dependencies: GuidedPolicyDependencies,
        authority_decision: Option<super::contracts::AuthorityDecision>,
    ) -> Self {
        Self {
            dependencies,
            authority_decision,
        }
    }

    pub(super) fn bound(
        dependencies: GuidedPolicyDependencies,
        authority_decision: Option<super::contracts::AuthorityDecision>,
    ) -> Self {
        Self {
            dependencies,
            authority_decision,
        }
    }
}

impl GuidedPolicyPort for GuidedPolicy {
    fn prepare<'a>(&'a self, invocation: GuidedInvocation<'a>) -> PortFuture<'a, PreparedPolicy> {
        Box::pin(async move {
            let rendered = self.dependencies.prompt.render(invocation).await?;
            Ok(PreparedPolicy {
                prompt: rendered.prompt,
                instructions: rendered.instructions,
                tools: rendered.tools,
                tool_choice: rendered.tool_choice,
                route_context: rendered.route_context,
                authority_decision: self.authority_decision.clone(),
                resumed_tool_call: rendered.resumed_tool_call,
                max_output_tokens: rendered.max_output_tokens,
                attachments: rendered.attachments,
                image_carrier: rendered.image_carrier,
                image_capability: rendered.image_capability,
                image_manifests: rendered.image_manifests,
                butler_data: rendered.butler_data,
                usage_attribution: rendered.usage_attribution,
                cache_scope: rendered.cache_scope,
                stable_provider_cache_prefix: rendered.stable_provider_cache_prefix,
                route_transport_attempt_ordinal: rendered.route_transport_attempt_ordinal,
                verified_image_payload: self.dependencies.verified_image_payload.clone(),
                stream_observer: self.dependencies.stream_observer.clone(),
                identity_observer: self.dependencies.identity_observer.clone(),
                synthesize_after_tool_candidate: rendered.synthesize_after_tool_candidate,
                synthesize_after_tool_empty: rendered.synthesize_after_tool_empty,
            })
        })
    }

    fn before_model_round<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
    ) -> PortFuture<'a, Vec<SteeringObservation>> {
        self.dependencies.context.steering(invocation)
    }

    fn resolve_tools<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        fallback: &'a [ModelRoundTool],
        final_report: bool,
    ) -> PortFuture<'a, (Vec<ModelRoundTool>, Option<String>)> {
        self.dependencies
            .tools
            .surface(invocation, fallback, final_report)
    }

    fn begin_context<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        budget: Option<std::sync::Arc<dyn crate::btcc::TurnContinuationBudgetPort>>,
    ) -> PortFuture<'a, Box<dyn super::guided_ports::TurnContextProjection + 'a>> {
        self.dependencies.context.begin_turn(invocation, budget)
    }

    fn prepare_context<'a>(
        &'a self,
        context: &'a dyn super::guided_ports::TurnContextProjection,
        invocation: GuidedInvocation<'a>,
        input: ContextProjectionInput<'a>,
    ) -> ContextProjectionFuture<'a> {
        context.project(invocation, input)
    }

    fn execute_tool<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        call: &'a ModelRoundToolCall,
        contract_version: Option<u8>,
    ) -> Pin<
        Box<dyn Future<Output = Result<crate::json::JsonDocument, ToolExecutionError>> + Send + 'a>,
    > {
        if matches!(
            call.name.as_str(),
            "list_operation_results" | "read_operation_results"
        ) {
            return Box::pin(async move {
                let runtime = invocation.operation_results.ok_or_else(|| {
                    ToolExecutionError::Integrity(crate::btcc::BtccError::detected(
                        BtccCode::OperationResultExactReadUnavailable,
                        "operation_result_exact_read_unavailable",
                    ))
                })?;
                if call.name == "list_operation_results" {
                    runtime.list_tool(&call.arguments).await
                } else {
                    runtime.read_tool(&call.arguments).await
                }
                .map_err(ToolExecutionError::Integrity)
                .and_then(|value| {
                    crate::json::JsonDocument::from_value(&value).map_err(|error| {
                        ToolExecutionError::Integrity(crate::btcc::BtccError::detected(
                            BtccCode::GuidedToolResultJson,
                            error.to_string(),
                        ))
                    })
                })
            });
        }
        self.dependencies
            .tools
            .execute(invocation, call, contract_version)
    }

    fn record_unexecuted<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        call: &'a ModelRoundToolCall,
        result: &'a ToolResult,
    ) -> PortFuture<'a, ()> {
        self.dependencies
            .tools
            .record_unexecuted(invocation, call, result)
    }

    fn assistant_before_tools<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        text: &'a str,
        calls: &'a [ModelRoundToolCall],
        iteration: u32,
    ) -> PortFuture<'a, ()> {
        self.dependencies
            .journal
            .assistant_before_tools(invocation, text, calls, iteration)
    }

    fn after_tool_batch<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        calls: &'a [ModelRoundToolCall],
        results: &'a [ToolResult],
        iteration: u32,
    ) -> PortFuture<'a, BatchDisposition> {
        self.dependencies
            .work
            .after_batch(invocation, calls, results, iteration)
    }

    fn outcome_from_tool_result<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        call: &'a ModelRoundToolCall,
        result: &'a ToolResult,
    ) -> PortFuture<'a, Option<ToolOutcome>> {
        self.dependencies.journal.outcome(invocation, call, result)
    }

    fn review_final_candidate<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        text: &'a str,
        iteration: u32,
    ) -> PortFuture<'a, CandidateDisposition> {
        self.dependencies
            .work
            .review_candidate(invocation, text, iteration)
    }

    fn handle_text_tool_calls<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        names: &'a [String],
        calls: &'a [ModelRoundToolCall],
        text: &'a str,
        iteration: u32,
    ) -> PortFuture<'a, TextCallDisposition> {
        self.dependencies
            .journal
            .handle_text_tool_calls(invocation, names, calls, text, iteration)
    }

    fn synthesize_final<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        messages: &'a [ModelRoundMessage],
        iteration: u32,
    ) -> PortFuture<'a, String> {
        self.dependencies
            .journal
            .synthesize_final(invocation, messages, iteration)
    }

    fn accept_tool_candidate<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        text: &'a str,
    ) -> PortFuture<'a, bool> {
        self.dependencies
            .journal
            .accept_tool_candidate(invocation, text)
    }

    fn operation_result_call_id(&self, provider_call_id: &str) -> Option<String> {
        self.dependencies
            .tools
            .operation_result_call_id(provider_call_id)
    }

    fn tool_result_message<'a>(
        &'a self,
        turn: &'a TurnRecord,
        result: &'a ToolResult,
        references: &'a super::operation_result_replay::OperationResultMessageReferences,
    ) -> PortFuture<'a, ModelRoundMessage> {
        self.dependencies
            .tools
            .result_message(turn, result, references)
    }

    fn presentation<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
    ) -> PortFuture<'a, Option<GuidedPresentation>> {
        self.dependencies.authority.presentation(invocation)
    }

    fn closeout<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        input: CloseoutInput<'a>,
    ) -> PortFuture<'a, GuidedCloseout> {
        Box::pin(async move {
            let content = if input.suspension.is_some() {
                String::new()
            } else {
                self.dependencies
                    .work
                    .reconcile(invocation, input.content)
                    .await?
            };
            let final_work = self.dependencies.work.final_state(invocation).await?;
            let accepted_work_result = if input.suspension.is_some() {
                None
            } else {
                self.dependencies.work.accepted_result(invocation).await?
            };
            let journal = self.dependencies.journal.closeout(invocation).await?;
            let model_identity = invocation.model_execution.accepted_model_identity();
            Ok(GuidedCloseout {
                content,
                work_status: final_work.status,
                accepted_work_result,
                runtime_failure: None,
                artifacts: journal.artifacts,
                changed_files: journal.changed_files,
                plan: journal.plan,
                model_identity,
                has_final_work: final_work.has_work,
            })
        })
    }
}
