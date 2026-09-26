//! Current source authority for a claimed semantic window.

use super::{CognitionResult, State};
use crate::cognition::{
    CognitionError, assert_conversation_source_current, sources::read_typed_record,
};

#[derive(Clone)]
pub(crate) enum ProjectionSourceNotice {
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
    CognitionError::new("memory_source_changed", "memory_source_changed")
}
