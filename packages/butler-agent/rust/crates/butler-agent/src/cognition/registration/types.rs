use std::path::PathBuf;

use tokio_util::sync::CancellationToken;

use crate::cognition::{GraphProgress, MemoryGenerationTarget};
use crate::coordination::CognitionWaitClass;

#[derive(Clone, Debug)]
pub(crate) enum OwnedConversationSourceNotice {
    Turn {
        session_id: String,
        turn_id: String,
        outcome_generation: f64,
        extraction_version: String,
    },
    Standalone {
        session_id: String,
        message_id: String,
        source_hash: String,
        extraction_version: String,
    },
}

impl OwnedConversationSourceNotice {
    pub(super) fn borrowed(&self) -> crate::cognition::ConversationSourceNotice<'_> {
        match self {
            Self::Turn {
                session_id,
                turn_id,
                outcome_generation,
                extraction_version,
            } => crate::cognition::ConversationSourceNotice::Turn {
                session_id,
                turn_id,
                outcome_generation: *outcome_generation,
                extraction_version,
            },
            Self::Standalone {
                session_id,
                message_id,
                source_hash,
                extraction_version,
            } => crate::cognition::ConversationSourceNotice::Standalone {
                session_id,
                message_id,
                source_hash,
                extraction_version,
            },
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct RegisterConversationSourceInput {
    pub data_root: PathBuf,
    pub target: MemoryGenerationTarget,
    pub notice: OwnedConversationSourceNotice,
    pub completion_job_id: Option<String>,
    pub cancellation: Option<CancellationToken>,
    pub deadline_at_epoch_ms: Option<f64>,
    pub wait_class: CognitionWaitClass,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum ConversationRegistrationOutcome {
    Registered(GraphProgress),
    Replayed(GraphProgress),
    InternalControlSuperseded,
}
