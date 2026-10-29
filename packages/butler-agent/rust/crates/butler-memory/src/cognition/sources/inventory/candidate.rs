//! What one canonical turn or recovered message contributes to the
//! inventory of every recall, before any scope or time applies.

use butler_turn::conversation::{
    ConversationError, ConversationMessageWithParts, ConversationOriginKind, ConversationRole,
    ConversationSourceReader, ConversationStatus, RecallOutcomeRow, decode_message_scalars,
};

use super::super::identity::{RevisionTail, episode_revision, recovered_parts_hash};
use super::{hash, unavailable};
use crate::cognition::{CognitionError, CognitionResult};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::cognition) enum CandidateKind {
    Turn,
    Message,
}

/// One turn outcome or recovered message of the canonical store.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::cognition) struct InventoryCandidate {
    pub kind: CandidateKind,
    /// The turn or message id.
    pub id: String,
    pub session_id: String,
    /// The turn's request and public answer, as its outcome names them.
    pub request_message_id: Option<String>,
    pub assistant_message_id: Option<String>,
    /// Set when the source is eligible apart from scope and time.
    pub eligible: Option<EligibleSource>,
    /// Set when the source could not be read; a recall reports it the way
    /// the full canonical scan does.
    pub fault: Option<SourceFault>,
}

/// A source whose stored data could not be read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::cognition) struct SourceFault {
    pub message: String,
    pub scope: FaultScope,
}

/// Which recalls report a fault, as the full canonical scan reads it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::cognition) enum FaultScope {
    /// Every recall: a recall outcome or recovered message page is read
    /// before any scope applies.
    EveryRecall,
    /// A recall that admits the source's session: a turn's request and
    /// answer are read once its session is in scope.
    AdmittedSession,
    /// A recall that admits the source by scope and time: a recovered
    /// message's revision is computed last.
    AdmittedInTime,
}

impl SourceFault {
    pub(in crate::cognition) fn error(&self) -> crate::cognition::CognitionError {
        crate::cognition::CognitionError::new(
            crate::cognition::CognitionCode::MemorySourceUnavailable,
            self.message.clone(),
        )
    }
}

/// The message to keep for a source whose read failed with `error` when
/// its stored data is unreadable; a store failure (busy, I/O, memory) is
/// returned so the step retries instead.
pub(in crate::cognition) fn fault_message(error: CognitionError) -> CognitionResult<String> {
    let mut cause = std::error::Error::source(&error);
    while let Some(current) = cause {
        if let Some(store) = current.downcast_ref::<ConversationError>() {
            return if store.is_unreadable_data() {
                Ok(error.message())
            } else {
                Err(error)
            };
        }
        cause = current.source();
    }
    Ok(error.message())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::cognition) struct EligibleSource {
    pub episode_id: String,
    /// `None` for a turn whose outcome generation is not finite: a recall
    /// that admits it reports the source unavailable.
    pub revision: Option<String>,
    /// When each message of the source was created.
    pub created_at: Vec<String>,
}

impl InventoryCandidate {
    pub(in crate::cognition) fn key(&self) -> String {
        source_key(self.kind, &self.id)
    }
}

pub(in crate::cognition) fn source_key(kind: CandidateKind, id: &str) -> String {
    match kind {
        CandidateKind::Turn => format!("turn:{id}"),
        CandidateKind::Message => format!("message:{id}"),
    }
}

/// The turn of one recall outcome.
pub(in crate::cognition) fn turn(
    reader: &ConversationSourceReader,
    outcome: &RecallOutcomeRow,
) -> CognitionResult<InventoryCandidate> {
    let eligible = match turn_messages(reader, outcome)? {
        Ok(messages) => {
            let scalars = messages
                .iter()
                .flat_map(decode_message_scalars)
                .collect::<Vec<_>>();
            if scalars.is_empty() {
                None
            } else {
                let revision = outcome
                    .generation
                    .is_finite()
                    .then(|| {
                        episode_revision(&scalars, &RevisionTail::Generation(outcome.generation))
                            .map_err(unavailable)
                    })
                    .transpose()?;
                Some(EligibleSource {
                    episode_id: turn_episode_id(&outcome.turn_id)?,
                    revision,
                    created_at: messages
                        .iter()
                        .map(|message| message.message.created_at.clone())
                        .collect(),
                })
            }
        }
        Err(_) => None,
    };
    Ok(InventoryCandidate {
        kind: CandidateKind::Turn,
        id: outcome.turn_id.clone(),
        session_id: outcome.session_id.clone(),
        request_message_id: outcome.request_message_id.clone(),
        assistant_message_id: outcome.public_assistant_message_id.clone(),
        eligible,
        fault: None,
    })
}

/// [`turn`], keeping unreadable stored data as the candidate's fault.
pub(in crate::cognition) fn turn_or_fault(
    reader: &ConversationSourceReader,
    outcome: &RecallOutcomeRow,
) -> CognitionResult<InventoryCandidate> {
    match turn(reader, outcome) {
        Ok(candidate) => Ok(candidate),
        Err(error) => Ok(InventoryCandidate {
            request_message_id: outcome.request_message_id.clone(),
            assistant_message_id: outcome.public_assistant_message_id.clone(),
            ..faulted(
                CandidateKind::Turn,
                &outcome.turn_id,
                &outcome.session_id,
                fault_message(error)?,
                FaultScope::AdmittedSession,
            )
        }),
    }
}

/// [`recovered`], keeping a failed revision as a fault reported where the
/// recovered message is admitted.
pub(in crate::cognition) fn recovered_or_fault(
    message: &ConversationMessageWithParts,
) -> CognitionResult<InventoryCandidate> {
    match recovered(message) {
        Ok(candidate) => Ok(candidate),
        Err(error) => {
            let id = &message.message.id;
            let session = &message.message.session_id;
            let scope = FaultScope::AdmittedInTime;
            Ok(InventoryCandidate {
                eligible: Some(EligibleSource {
                    episode_id: message_episode_id(id)?,
                    revision: None,
                    created_at: vec![message.message.created_at.clone()],
                }),
                ..faulted(
                    CandidateKind::Message,
                    id,
                    session,
                    fault_message(error)?,
                    scope,
                )
            })
        }
    }
}

/// A source whose stored data could not be read.
pub(in crate::cognition) fn faulted(
    kind: CandidateKind,
    id: &str,
    session_id: &str,
    message: String,
    scope: FaultScope,
) -> InventoryCandidate {
    InventoryCandidate {
        kind,
        id: id.to_owned(),
        session_id: session_id.to_owned(),
        request_message_id: None,
        assistant_message_id: None,
        eligible: None,
        fault: Some(SourceFault { message, scope }),
    }
}

/// One recovered standalone message.
pub(in crate::cognition) fn recovered(
    message: &ConversationMessageWithParts,
) -> CognitionResult<InventoryCandidate> {
    let scalars = decode_message_scalars(message);
    let eligible = if scalars.is_empty() {
        None
    } else {
        let source_hash = recovered_parts_hash(message).map_err(unavailable)?;
        Some(EligibleSource {
            episode_id: message_episode_id(&message.message.id)?,
            revision: Some(
                episode_revision(&scalars, &RevisionTail::SourceHash(source_hash))
                    .map_err(unavailable)?,
            ),
            created_at: vec![message.message.created_at.clone()],
        })
    };
    Ok(InventoryCandidate {
        kind: CandidateKind::Message,
        id: message.message.id.clone(),
        session_id: message.message.session_id.clone(),
        request_message_id: None,
        assistant_message_id: None,
        eligible,
        fault: None,
    })
}

pub(super) fn turn_episode_id(turn_id: &str) -> CognitionResult<String> {
    hash(&("canonical-conversation-turn", turn_id))
}

pub(super) fn message_episode_id(message_id: &str) -> CognitionResult<String> {
    hash(&("canonical-conversation-message", message_id))
}

/// The terminal turn's request and public answer; `Err` with the exclusion
/// code when the turn or a message is ineligible (`None` without a request).
pub(super) fn turn_messages(
    reader: &ConversationSourceReader,
    outcome: &RecallOutcomeRow,
) -> CognitionResult<Result<Vec<ConversationMessageWithParts>, Option<&'static str>>> {
    let turn = reader.read_turn(&outcome.turn_id).map_err(unavailable)?;
    if turn.as_ref().is_none_or(|turn| {
        turn.id != outcome.turn_id
            || turn.session_id != outcome.session_id
            || !matches!(turn.status.as_str(), "complete" | "failed" | "aborted")
    }) {
        return Ok(Err(Some("turn_not_terminal")));
    }
    let read = |id: Option<&str>| {
        id.map(|id| reader.read_message(id))
            .transpose()
            .map_err(unavailable)
            .map(Option::flatten)
    };
    let request = read(outcome.request_message_id.as_deref())?;
    let assistant = read(outcome.public_assistant_message_id.as_deref())?;
    let unknown = |message: &Option<ConversationMessageWithParts>| {
        message
            .as_ref()
            .is_some_and(|message| message.message.origin_kind == ConversationOriginKind::Unknown)
    };
    if request.as_ref().is_none_or(|message| {
        message.message.role != ConversationRole::User
            || !matches!(
                message.message.status,
                ConversationStatus::Complete | ConversationStatus::Compacted
            )
            || message.message.origin_kind != ConversationOriginKind::UserInput
    }) {
        return Ok(Err(Some(if unknown(&request) {
            "unknown_origin"
        } else {
            "request_ineligible"
        })));
    }
    if assistant
        .as_ref()
        .is_some_and(|message| message.message.origin_kind == ConversationOriginKind::Connector)
    {
        return Ok(Ok(request.into_iter().collect()));
    }
    if outcome.public_assistant_message_id.is_some()
        && assistant.as_ref().is_none_or(|message| {
            message.message.role != ConversationRole::Assistant
                || message.message.status != ConversationStatus::Complete
                || message.message.origin_kind != ConversationOriginKind::AssistantPublic
        })
    {
        return Ok(Err(Some(if unknown(&assistant) {
            "unknown_origin"
        } else {
            "assistant_ineligible"
        })));
    }
    let Some(request) = request else {
        return Ok(Err(None));
    };
    Ok(Ok([Some(request), assistant]
        .into_iter()
        .flatten()
        .collect()))
}
