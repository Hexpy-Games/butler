use std::path::PathBuf;

use tokio_util::sync::CancellationToken;

use crate::cognition::{GraphProgress, MemoryGenerationTarget};
use crate::coordination::CognitionWaitClass;

/// An owned `ConversationSourceNotice`.
#[derive(Clone, Debug)]
pub enum OwnedConversationSourceNotice {
    /// A finished turn.
    Turn {
        /// Conversation session.
        session_id: String,
        /// Turn id.
        turn_id: String,
        /// Generation of the turn outcome.
        outcome_generation: f64,
        /// Extraction version.
        extraction_version: String,
    },
    /// A recovered message outside any turn.
    Standalone {
        /// Conversation session.
        session_id: String,
        /// Message id.
        message_id: String,
        /// Recovered-parts hash of the message.
        source_hash: String,
        /// Extraction version.
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

/// A conversation source to register in a memory generation.
#[derive(Clone, Debug)]
pub struct RegisterConversationSourceInput {
    /// Butler data root.
    pub data_root: PathBuf,
    /// Generation to register in.
    pub target: MemoryGenerationTarget,
    /// The source.
    pub notice: OwnedConversationSourceNotice,
    /// Completion job that observed the source, when any.
    pub completion_job_id: Option<String>,
    /// Stops the registration when cancelled.
    pub cancellation: Option<CancellationToken>,
    /// Give up after this time (milliseconds since the epoch).
    pub deadline_at_epoch_ms: Option<f64>,
    /// How long to wait for the writer lock.
    pub wait_class: CognitionWaitClass,
}

/// What registering a conversation source did.
#[derive(Clone, Debug, PartialEq)]
pub enum ConversationRegistrationOutcome {
    /// The source was registered; its projection progress.
    Registered(GraphProgress),
    /// The same source revision was already registered; its progress.
    Replayed(GraphProgress),
    /// The turn was internal control, so an earlier registration was superseded.
    InternalControlSuperseded,
}
