//! Resolve a durable pending job's notice while holding the claim lease.

use super::{ProjectionSourceNotice, State};
use crate::cognition::{
    CognitionCode, CognitionConversationSourceNotice, CognitionError, CognitionResult,
    graph::PendingSemanticJob,
    sources::{read_typed_record, recovered_parts_hash},
};

pub(super) fn resolve(state: &mut State) -> CognitionResult<()> {
    if let ProjectionSourceNotice::Pending(pending) = &state.input.notice {
        state.input.notice = notice(state, pending)?;
    }
    Ok(())
}

fn notice(state: &State, pending: &PendingSemanticJob) -> CognitionResult<ProjectionSourceNotice> {
    if let Some(turn_id) = pending.source_key.strip_prefix("conversation_turn:") {
        let outcome = state
            .canonical
            .read_turn_outcome(turn_id)?
            .ok_or_else(changed)?;
        Ok(ProjectionSourceNotice::Conversation(
            CognitionConversationSourceNotice::Turn {
                session_id: pending.session_id.clone().ok_or_else(changed)?,
                turn_id: turn_id.into(),
                outcome_generation: outcome.generation,
                extraction_version: pending.extraction_version.clone(),
            },
        ))
    } else if let Some(message_id) = pending.source_key.strip_prefix("conversation_message:") {
        let message = state
            .canonical
            .read_message(message_id)?
            .ok_or_else(changed)?;
        // Older planners persisted the episode revision in source_hash. Build
        // the notice from canonical parts; refresh repairs same-revision metadata.
        let source_hash = recovered_parts_hash(&message)?;
        Ok(ProjectionSourceNotice::Conversation(
            CognitionConversationSourceNotice::Standalone {
                session_id: message.message.session_id,
                message_id: message_id.into(),
                source_hash,
                extraction_version: pending.extraction_version.clone(),
            },
        ))
    } else if let Some((kind, record_id)) = pending.source_key.split_once(':')
        && matches!(kind, "task_report" | "explicit_record")
    {
        let owner = read_typed_record(
            &state.handle.source_root,
            &state.handle.source_root.join("cognition/memory"),
            kind,
            record_id,
        )?
        .ok_or_else(changed)?;
        if owner.content_hash != pending.source_hash {
            return Err(changed());
        }
        Ok(ProjectionSourceNotice::Typed {
            source_kind: kind.into(),
            record_id: record_id.into(),
            revision: owner.revision,
            content_hash: owner.content_hash,
            operation_id: owner.operation_id,
        })
    } else {
        Err(CognitionError::new(
            CognitionCode::MemoryProjectionSourceInvalid,
            "memory_projection_source_invalid",
        ))
    }
}

fn changed() -> CognitionError {
    CognitionError::new(CognitionCode::MemorySourceChanged, "memory_source_changed")
}
