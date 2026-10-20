//! One semantic/cache/vector quantum, shared by serving and rebuild consumers.
use super::Input;
use crate::cognition::CognitionResult;

pub(super) async fn process(input: &Input) -> CognitionResult<bool> {
    let (projected, generation) = super::project_next(input).await?;
    let cached = super::cache::process(input, generation.as_ref()).await?;
    let vectorized = super::super::vector_schedule::process(
        input,
        generation.as_ref(),
        projected || cached.text_advanced,
    )
    .await?;
    Ok(projected || cached.processed || vectorized)
}

/// Stored hash metadata can predate the parts-hash format. Rebuild the notice
/// from canonical parts; the claim refreshes metadata only at the same revision.
pub(super) fn standalone_notice(
    input: &Input,
    handle: &crate::cognition::MemoryGenerationHandle,
    pending: &crate::cognition::graph::PendingSemanticJob,
    message_id: &str,
) -> CognitionResult<super::ProjectionSourceNotice> {
    use crate::cognition::{CognitionCode, CognitionError, sources::recovered_parts_hash};
    let canonical = butler_turn::conversation::ConversationSourceReader::open(
        &super::canonical_path(handle, &input.data_root),
    )
    .map_err(CognitionError::from)?;
    let message = canonical.read_message(message_id)?.ok_or_else(|| {
        CognitionError::new(CognitionCode::MemorySourceChanged, "memory_source_changed")
    })?;
    let source_hash = recovered_parts_hash(&message)?;
    canonical.close().map_err(CognitionError::from)?;
    Ok(super::ProjectionSourceNotice::Conversation(
        crate::cognition::CognitionConversationSourceNotice::Standalone {
            session_id: message.message.session_id,
            message_id: message_id.into(),
            source_hash,
            extraction_version: pending.extraction_version.clone(),
        },
    ))
}
