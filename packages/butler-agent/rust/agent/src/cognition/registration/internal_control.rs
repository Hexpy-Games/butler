//! Source-equivalent retirement of an internal-control Conversation projection.

use std::sync::Arc;

use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::{Clock, ConversationRegistrationOutcome, RegisterConversationSourceInput};
use crate::{
    cognition::{
        CognitionError, CognitionPathEnvironment, CognitionResult, MemoryGenerationHandle,
        PreparedConversationSource, assert_mutation_authority,
        graph::{GraphRepository, InternalSupersessionInput},
        prepare_conversation_source,
        sources::projection_hash_for_graph,
    },
    conversation::{ConversationOriginKind, ConversationSourceReader},
    coordination::CognitionWriteCoordinator,
};

pub(super) struct Input {
    pub environment: CognitionPathEnvironment,
    pub coordinator: Arc<CognitionWriteCoordinator>,
    pub clock: Clock,
    pub shutdown: CancellationToken,
    pub input: RegisterConversationSourceInput,
    pub handle: MemoryGenerationHandle,
    pub turn_id: String,
}

pub(super) async fn run(state: Input) -> CognitionResult<ConversationRegistrationOutcome> {
    let lock_path = state.environment.consolidation_lock(&state.input.data_root);
    let lease = super::acquire(
        &state.coordinator,
        lock_path.clone(),
        &state.input,
        &state.shutdown,
    )
    .await?;
    tokio::task::spawn_blocking(move || {
        let result = (|| {
            lease
                .assert_for_path(&lock_path)
                .map_err(super::coordination_error)?;
            assert_mutation_authority(
                &state.input.data_root,
                &state.environment,
                &state.input.target,
                &state.handle,
            )?;
            let path = state
                .handle
                .canonical_snapshot_path
                .clone()
                .unwrap_or_else(|| {
                    state
                        .handle
                        .source_root
                        .join("runtime/conversation-store.sqlite")
                });
            let canonical =
                ConversationSourceReader::open(&path).map_err(super::conversation_error)?;
            let result = supersede(&state, &canonical);
            canonical
                .close()
                .map_err(super::conversation_error)
                .and(result)
        })();
        let release = lease
            .release(result.is_ok())
            .map_err(super::coordination_error);
        release.and(result)
    })
    .await
    .map_err(super::join_error)?
}

fn supersede(
    state: &Input,
    canonical: &ConversationSourceReader,
) -> CognitionResult<ConversationRegistrationOutcome> {
    match prepare_conversation_source(canonical, state.input.notice.borrowed(), &(state.clock)())? {
        PreparedConversationSource::SupersedeInternalControl { turn_id }
            if turn_id == state.turn_id => {}
        _ => return Err(changed()),
    }
    let outcome = canonical
        .read_turn_outcome(&state.turn_id)
        .map_err(super::conversation_error)?
        .ok_or_else(changed)?;
    let request_id = outcome.request_message_id.as_deref().ok_or_else(changed)?;
    let request = canonical
        .read_message(request_id)
        .map_err(super::conversation_error)?
        .ok_or_else(changed)?;
    if request.message.session_id != outcome.session_id
        || request.message.turn_id.as_deref() != Some(&state.turn_id)
        || request.message.origin_kind != ConversationOriginKind::InternalControl
    {
        return Err(changed());
    }
    let mut internal_ids = vec![request_id.to_owned()];
    if let Some(assistant_id) = outcome.public_assistant_message_id.as_deref() {
        let assistant = canonical
            .read_message(assistant_id)
            .map_err(super::conversation_error)?;
        if assistant.is_some_and(|message| {
            message.message.origin_kind == ConversationOriginKind::InternalControl
        }) {
            internal_ids.push(assistant_id.to_owned());
        }
    }
    let episode_id = projection_hash_for_graph(vec![
        Value::String("canonical-conversation-turn".into()),
        Value::String(state.turn_id.clone()),
    ])?;
    let mut graph = GraphRepository::open(&state.handle.graph_path)?;
    let ids = internal_ids.iter().map(String::as_str).collect::<Vec<_>>();
    let result = graph.ensure_schema(&(state.clock)()).and_then(|()| {
        graph.supersede_internal_projection(InternalSupersessionInput {
            episode_id: &episode_id,
            internal_control_message_ids: &ids,
        })
    });
    graph.close().and(result)?;
    Ok(ConversationRegistrationOutcome::InternalControlSuperseded)
}

fn changed() -> CognitionError {
    CognitionError::new("memory_source_changed", "memory_source_changed")
}
