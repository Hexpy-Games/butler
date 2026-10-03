use super::*;
#[cfg(debug_assertions)]
mod faults;

pub(in crate::btcc::agent_loop) async fn stub_boundary(
    input: &Invocation<'_>,
    kind: &str,
) -> Result<(), AgentLoopError> {
    #[cfg(debug_assertions)]
    faults::hold(GuidedInvocation::from(input), kind)
        .await
        .map_err(propagated)?;
    #[cfg(not(debug_assertions))]
    let _ = (input, kind);
    Ok(())
}

pub(super) async fn safe_point(
    input: &Invocation<'_>,
    state: &mut State,
) -> Result<bool, AgentLoopError> {
    let observations = input
        .policy
        .before_model_round(GuidedInvocation::from(input))
        .await
        .map_err(propagated)?;
    let changed = !observations.is_empty();
    if changed {
        stub_boundary(input, "injection").await?;
    }
    if open_calls(state) {
        state.pending_steering.extend(observations);
    } else {
        append_observations(state, observations);
    }
    Ok(changed)
}

pub(super) async fn fence_calls(
    input: &Invocation<'_>,
    state: &mut State,
    calls: &[ModelRoundToolCall],
    iteration: u32,
) -> Result<(), AgentLoopError> {
    for call in calls {
        let result = ToolResult {
            tool_call_id: call.id.clone(),
            name: call.name.clone(),
            ok: false,
            error: Some(super::super::contracts::ToolError {
                code: "instruction_response_fenced".into(),
                message:
                    "A new instruction arrived. Re-read current state before requesting tools."
                        .into(),
                field: None,
            }),
            output: None,
        };
        input
            .policy
            .record_unexecuted(GuidedInvocation::from(input), call, &result)
            .await
            .map_err(propagated)?;
        record_result(
            input,
            state,
            call,
            result,
            iteration,
            OutcomeCheck::RecordOnly,
        )
        .await?;
    }
    let observations = std::mem::take(&mut state.pending_steering);
    append_observations(state, observations);
    Ok(())
}

fn open_calls(state: &State) -> bool {
    let Some(index) = state
        .messages
        .iter()
        .rposition(|m| m.tool_calls.as_ref().is_some_and(|calls| !calls.is_empty()))
    else {
        return false;
    };
    state
        .messages
        .get(index)
        .and_then(|m| m.tool_calls.as_ref())
        .into_iter()
        .flatten()
        .any(|call| {
            !state
                .messages
                .iter()
                .skip(index + 1)
                .any(|m| m.tool_call_id.as_deref() == Some(&call.id))
        })
}

pub(in crate::btcc::agent_loop) async fn may_finish(
    input: &Invocation<'_>,
    state: &mut State,
    final_answer: bool,
) -> Result<bool, AgentLoopError> {
    stub_boundary(input, if final_answer { "answer" } else { "wait" }).await?;
    if safe_point(input, state).await? {
        return Ok(false);
    }
    input
        .policy
        .seal(GuidedInvocation::from(input), final_answer)
        .await
        .map_err(propagated)
}
