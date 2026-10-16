//! What one canonical turn or recovered message contributes to the
//! inventory of every recall, before any scope or time applies.

use butler_turn::conversation::{
    ConversationMessageWithParts, ConversationOriginKind, ConversationRole,
    ConversationSourceReader, ConversationStatus, RecallOutcomeRow, decode_message_scalars,
};

use super::super::identity::{RevisionTail, episode_revision, recovered_parts_hash};
use super::{hash, unavailable};
use crate::cognition::CognitionResult;

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
    })
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
