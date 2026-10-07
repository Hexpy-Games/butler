//! Preserve every concurrent result before parking on the first authority request.
use super::*;

pub(super) async fn run_concurrent_batch(
    input: &Invocation<'_>,
    state: &mut State,
    prepared: &PreparedPolicy,
    batch: &ToolBatch<'_>,
) -> Result<Step, AgentLoopError> {
    for call in batch.prepared_calls {
        emit_tool_call(input, call, batch.iteration);
    }
    let results = tool_batch::execute_concurrent(
        input.policy,
        GuidedInvocation::from(input),
        batch.prepared_calls,
    )
    .await
    .map_err(propagated)?;
    if results
        .iter()
        .any(|result| pending_authority(result.output.as_ref()).is_some())
    {
        // Start with a non-resumed cursor: every pending call, including the
        // first, must park before execution with its own decision.
        return run_sequential_batch(
            input,
            state,
            prepared,
            batch,
            BatchCursor {
                start: 0,
                results: Vec::new(),
                resumed: false,
                concurrent_results: results,
                concurrent_call_ids: batch
                    .calls
                    .iter()
                    .map(|call| {
                        input
                            .policy
                            .operation_result_call_id(&call.id)
                            .unwrap_or_default()
                    })
                    .collect(),
            },
        )
        .await;
    }
    let mut first_outcome = None;
    for (call, result) in batch.prepared_calls.iter().zip(&results) {
        state.used_tools.push(call.call.name.clone());
        let check = if first_outcome.is_none() {
            OutcomeCheck::Evaluate
        } else {
            OutcomeCheck::RecordOnly
        };
        let outcome = record_result(
            input,
            state,
            &call.call,
            result.clone(),
            batch.iteration,
            check,
            None,
        )
        .await?;
        if first_outcome.is_none() {
            first_outcome = outcome;
        }
    }
    if let Some(result) = finish_outcome(input, state, first_outcome).await? {
        return Ok(Step::finished(result));
    }
    settle_batch(input, state, batch, &results).await
}
