use std::{future::Future, pin::Pin};

use serde_json::json;

use crate::btcc::{BtccError, PortFuture, RuntimeTurnEventInput, TurnRecord};

use super::continuation::GuidedPresentation;
use super::contracts::*;
use super::guided_ports::*;
use super::ports::ToolExecutionError;
use super::test_support::Fixture;

async fn observe_scope(invocation: GuidedInvocation<'_>, phase: &str) {
    let mut event = RuntimeTurnEventInput::new(format!("test.guided.{phase}"));
    event.payload = json!({
        "turnId": invocation.turn.turn_id,
        "claimId": invocation.claim.claim_id,
        "recoveryAttempt": invocation.recovery_attempt,
        "cancelled": invocation.cancellation.is_cancelled(),
    })
    .as_object()
    .cloned();
    let _ = invocation.progress.emit(event).await;
}

impl PromptPort for Fixture {
    fn render<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
    ) -> PortFuture<'a, RenderedGuidedPrompt> {
        Box::pin(async move {
            observe_scope(invocation, "prompt").await;
            Ok(RenderedGuidedPrompt {
                prompt: invocation.turn.original_message.clone(),
                instructions: Some("guided".into()),
                tools: vec![super::test_data::tool("read_file", false)],
                tool_choice: Some(ToolChoice::Auto),
                resumed_tool_call: None,
                images: PromptImages::default(),
                request: RoundRequestOptions {
                    butler_data: Some("/tmp/butler".into()),
                    cache_scope: Some(format!("btcc-guided:{}", invocation.turn.session_id)),
                    ..Default::default()
                },
                final_synthesis: FinalSynthesis::Never,
            })
        })
    }
}

impl AuthorityPort for Fixture {
    fn presentation<'a>(
        &'a self,
        _: GuidedInvocation<'a>,
    ) -> PortFuture<'a, Option<GuidedPresentation>> {
        Box::pin(async { Ok(None) })
    }
}

impl ContextPort for Fixture {
    fn steering<'a>(
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
    fn begin_turn<'a>(
        &'a self,
        _: GuidedInvocation<'a>,
        _: Option<std::sync::Arc<dyn crate::btcc::TurnContinuationBudgetPort>>,
    ) -> PortFuture<'a, Box<dyn TurnContextProjection + 'a>> {
        Box::pin(
            async move { Ok(Box::new(BorrowedContext(self)) as Box<dyn TurnContextProjection>) },
        )
    }
}

struct BorrowedContext<'a>(&'a Fixture);

impl TurnContextProjection for BorrowedContext<'_> {
    fn project<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        _: ContextProjectionInput<'a>,
    ) -> super::ports::ContextProjectionFuture<'a> {
        Box::pin(async move {
            observe_scope(invocation, "context").await;
            Ok(ContextProjection {
                messages: ContextMessages::Transport,
                bounded_continuation: None,
                provider_body_admission: None,
                rebase: if std::mem::take(&mut *self.0.rebase_once.lock().unwrap()) {
                    ContextRebase::RequiredWithSteeringRecheck
                } else {
                    ContextRebase::NotRequired
                },
            })
        })
    }
}

impl ToolPort for Fixture {
    fn surface<'a>(
        &'a self,
        _invocation: GuidedInvocation<'a>,
        fallback: &'a [ModelRoundTool],
        phase: LoopPhase,
    ) -> PortFuture<'a, ToolSurface> {
        Box::pin(async move {
            Ok(ToolSurface {
                tools: match phase {
                    LoopPhase::Working => fallback.to_vec(),
                    LoopPhase::FinalReport => vec![],
                },
                digest: Some("a".repeat(64)),
            })
        })
    }
    fn execute<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        call: &'a ModelRoundToolCall,
        _: Option<u8>,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<butler_core::json::JsonDocument, ToolExecutionError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            observe_scope(invocation, "tool").await;
            if invocation.cancellation.is_cancelled() {
                return Err(ToolExecutionError::Integrity(BtccError::relayed(
                    "turn_cancelled",
                    "turn_cancelled",
                )));
            }
            self.note(format!("execute:{}", call.name));
            butler_core::json::JsonDocument::from_value(
                &self
                    .tool_outputs
                    .lock()
                    .unwrap()
                    .get(&call.id)
                    .cloned()
                    .unwrap_or_else(|| json!({"value":call.id})),
            )
            .map_err(|error| {
                ToolExecutionError::Integrity(BtccError::relayed("tool_json", error.to_string()))
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
    fn operation_result_call_id(&self, provider_call_id: &str) -> Option<String> {
        Some(format!("journal-{provider_call_id}"))
    }
    fn result_message<'a>(
        &'a self,
        _: &'a TurnRecord,
        result: &'a ToolResult,
        references: &'a super::operation_result_replay::OperationResultMessageReferences,
    ) -> PortFuture<'a, ModelRoundMessage> {
        Box::pin(async move {
            self.result_references
                .lock()
                .unwrap()
                .push(references.clone());
            Ok(ModelRoundMessage {
                facts: Default::default(),
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
}

impl JournalPort for Fixture {
    fn handle_text_tool_calls<'a>(
        &'a self,
        _invocation: GuidedInvocation<'a>,
        _: &'a [String],
        _: &'a [ModelRoundToolCall],
        _: &'a str,
        _: u32,
    ) -> PortFuture<'a, TextCallDisposition> {
        Box::pin(async {
            Ok(TextCallDisposition::Fail(BtccError::relayed(
                "btcc_text_tool_calls_unsupported",
                "structured calls required",
            )))
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
    fn assistant_before_tools<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        _: &'a str,
        _: &'a [ModelRoundToolCall],
        _: u32,
    ) -> PortFuture<'a, ()> {
        Box::pin(async move {
            observe_scope(invocation, "journal").await;
            Ok(())
        })
    }
    fn outcome<'a>(
        &'a self,
        _invocation: GuidedInvocation<'a>,
        call: &'a ModelRoundToolCall,
        _: &'a ToolResult,
    ) -> PortFuture<'a, Option<ToolOutcome>> {
        Box::pin(async move { Ok(self.outcomes.lock().unwrap().get(&call.id).cloned()) })
    }
    fn closeout<'a>(&'a self, _: GuidedInvocation<'a>) -> PortFuture<'a, JournalCloseout> {
        Box::pin(async {
            Ok(JournalCloseout {
                artifacts: vec![],
                changed_files: vec![],
            })
        })
    }
}

impl WorkPort for Fixture {
    fn after_batch<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        _: &'a [ModelRoundToolCall],
        _: &'a [ToolResult],
        _: u32,
    ) -> PortFuture<'a, BatchDisposition> {
        Box::pin(async move {
            observe_scope(invocation, "work").await;
            Ok(self
                .batches
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(BatchDisposition::Continue))
        })
    }
    fn review_candidate<'a>(
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
    fn reconcile<'a>(
        &'a self,
        _invocation: GuidedInvocation<'a>,
        content: &'a str,
    ) -> PortFuture<'a, String> {
        Box::pin(async move { Ok(content.into()) })
    }
    fn final_state<'a>(&'a self, _: GuidedInvocation<'a>) -> PortFuture<'a, WorkFinalState> {
        Box::pin(async move {
            Ok(WorkFinalState {
                status: None,
                has_work: *self.has_work.lock().unwrap(),
            })
        })
    }
    fn accepted_result<'a>(
        &'a self,
        _: GuidedInvocation<'a>,
    ) -> PortFuture<'a, Option<crate::btcc::AcceptedWorkResult>> {
        Box::pin(async { Ok(None) })
    }
}
