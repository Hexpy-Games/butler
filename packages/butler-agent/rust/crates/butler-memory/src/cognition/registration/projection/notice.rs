//! Current source authority for a claimed semantic window.

use super::{CognitionResult, State};
use crate::cognition::CognitionCode;
use crate::cognition::{
    CognitionError, assert_conversation_source_current, sources::read_typed_record,
};

#[derive(Clone)]
pub(crate) enum ProjectionSourceNotice {
    /// A durable queue entry whose source is resolved under the claim lease.
    Pending(crate::cognition::graph::PendingSemanticJob),
    Conversation(super::super::CognitionConversationSourceNotice),
    Typed {
        source_kind: String,
        record_id: String,
        revision: String,
        content_hash: String,
        operation_id: String,
    },
}

impl From<super::super::CognitionConversationSourceNotice> for ProjectionSourceNotice {
    fn from(value: super::super::CognitionConversationSourceNotice) -> Self {
        Self::Conversation(value)
    }
}

pub(super) fn assert_notice_current(
    state: &State,
    revision: &str,
    now: &str,
) -> CognitionResult<()> {
    match &state.input.notice {
        ProjectionSourceNotice::Pending(_) => Err(CognitionError::new(
            CognitionCode::MemoryProjectionSourceInvalid,
            "memory_projection_source_invalid",
        )),
        ProjectionSourceNotice::Conversation(notice) => Ok(assert_conversation_source_current(
            &state.canonical,
            notice.borrowed(),
            revision,
            now,
        )?),
        ProjectionSourceNotice::Typed {
            source_kind,
            record_id,
            revision: expected,
            content_hash,
            operation_id,
        } => {
            if expected != revision {
                return Err(changed());
            }
            let owner = read_typed_record(
                &state.handle.source_root,
                &state.handle.source_root.join("cognition/memory"),
                source_kind,
                record_id,
            )?
            .ok_or_else(changed)?;
            if owner.revision != *expected
                || owner.content_hash != *content_hash
                || owner.operation_id != *operation_id
            {
                return Err(changed());
            }
            Ok(())
        }
    }
}

fn changed() -> CognitionError {
    CognitionError::new(CognitionCode::MemorySourceChanged, "memory_source_changed")
}

/// A pending standalone job may hold hash metadata written by an older planner.
/// Refresh it under the claim lease, after re-planning the canonical revision.
pub(super) fn refresh_source_hash(state: &State, now: &str) -> CognitionResult<()> {
    if let ProjectionSourceNotice::Conversation(
        notice @ crate::cognition::CognitionConversationSourceNotice::Standalone { .. },
    ) = &state.input.notice
    {
        let revision = state.graph.job_revision(&state.input.job_id)?;
        let result = state.graph.refresh_conversation_source_hash(
            &state.canonical,
            notice.borrowed(),
            &revision,
            now,
        );
        match result {
            // Source validation below the refresh settles these under the lease.
            Err(error) if crate::cognition::graph::source_validity::is_invalid(error.code()) => {}
            result => result?,
        }
    }
    Ok(())
}
