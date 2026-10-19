use super::{
    AttemptError, ContextProjection, Invocation, PreparedPolicy, ReplayPreparation, Round, State,
    ToolSurface, context_error,
};

pub(super) async fn project_context(
    round: &Round<'_, '_>,
    state: &State,
    replay: &ReplayPreparation,
    surface: &ToolSurface,
    response_item_id: &str,
) -> Result<ContextProjection, AttemptError> {
    let input = round.input;
    let model_ref = input.model_execution.active_model_ref();
    let source = ContextProjectionSource {
        model_ref: &model_ref,
        round_id: &round.identity.round_id,
        response_item_id,
        semantic_messages: &state.messages,
        transport_messages: replay.messages.as_deref().unwrap_or(&state.messages),
        tools: &surface.tools,
    };
    input
        .policy
        .prepare_context(
            round.context,
            super::super::guided_ports::GuidedInvocation::from(input),
            context_input(input, round.prepared, source),
        )
        .await
        .map_err(context_error)
}

#[derive(Clone, Copy)]
struct ContextProjectionSource<'a> {
    model_ref: &'a str,
    round_id: &'a str,
    response_item_id: &'a str,
    semantic_messages: &'a [super::super::contracts::ModelRoundMessage],
    transport_messages: &'a [super::super::contracts::ModelRoundMessage],
    tools: &'a [super::super::contracts::ModelRoundTool],
}

fn context_input<'a>(
    input: &'a Invocation<'_>,
    prepared: &'a PreparedPolicy,
    source: ContextProjectionSource<'a>,
) -> super::super::contracts::ContextProjectionInput<'a> {
    super::super::contracts::ContextProjectionInput {
        round_id: source.round_id,
        response_item_id: source.response_item_id,
        semantic_messages: source.semantic_messages,
        transport_messages: source.transport_messages,
        model_ref: source.model_ref,
        instructions: prepared.instructions.as_deref(),
        tools: source.tools,
        tool_choice: prepared.tool_choice,
        attachments: &prepared.images.attachments,
        butler_data: prepared.request.butler_data.as_deref(),
        max_model_facing_bytes: crate::btcc::continuation_budget::model_context_byte_limit(
            input.semantic.model.context_window_tokens,
        ),
    }
}
