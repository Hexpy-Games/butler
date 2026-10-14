//! Reporting retains cacheable tool definitions, but has no execution authority.
use super::super::contracts::{LoopPhase, ToolError};
use super::*;
use butler_core::tool_protocol::ToolName;

/// Answer blocks are part of the final reply itself, not further execution:
/// a reply round that only shows them still runs.
fn reply_part(reply: &Reply) -> bool {
    reply.text_call_names.is_empty()
        && reply
            .calls
            .iter()
            .all(|call| call.name == ToolName::AnswerBlocks)
}

pub(super) async fn reject_tools(
    input: &Invocation<'_>,
    state: &mut State,
    prepared: &PreparedPolicy,
    reply: &Reply,
    iteration: u32,
) -> Result<Option<Step>, AgentLoopError> {
    if state.phase != LoopPhase::FinalReport
        || (reply.calls.is_empty() && reply.text_call_names.is_empty())
        || reply_part(reply)
    {
        return Ok(None);
    }
    discard_round_text(prepared);
    if !reply.calls.is_empty() {
        announce_tool_round(input, &reply.text, &reply.calls, iteration).await?;
    }
    for call in &reply.calls {
        emit(
            input.observer,
            &AgentLoopEvent::ToolCall {
                iteration,
                call: call.clone(),
            },
        );
        let result = ToolResult {
            tool_call_id: call.id.clone(),
            name: call.name.clone(),
            ok: false,
            output: None,
            error: Some(ToolError {
                code: "final_report_tool_execution_blocked".into(),
                message: "Tool execution is closed. Report the recorded result in prose.".into(),
                field: None,
            }),
        };
        input
            .policy
            .record_unexecuted(GuidedInvocation::from(input), call, &result)
            .await
            .map_err(propagated)?;
        operation(input.progress, call, Status::Cancelled, None, None).await;
        record_result(
            input,
            state,
            call,
            result,
            iteration,
            OutcomeCheck::RecordOnly,
            None,
        )
        .await?;
    }
    let observation = state.feedback("Final report only: tool execution is closed. Use the recorded evidence and provide the final answer without tool calls.");
    state.messages.push(ModelRoundMessage::user(
        observation,
        Some("final_report_policy".into()),
    ));
    Ok(Some(Step::Continue))
}
