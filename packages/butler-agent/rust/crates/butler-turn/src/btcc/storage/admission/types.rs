use serde_json::Value;

use crate::btcc::storage::common::error;
use crate::btcc::storage::{StorageError, StorageResult};
use crate::btcc::{
    CommandMessage, CommandModelSelection, CommandTrigger, ProgressDestination, StorageCode,
    TurnCommand,
};

pub(super) struct Inbox {
    pub(super) inbox_id: String,
    pub(super) turn_id: String,
    pub(super) admission_input_hash: String,
    pub(super) status: String,
    pub(super) command_json: String,
}

pub(super) struct AdmissionClaim {
    pub(super) claim_id: String,
}
/// The admitted source of a fresh command: its user message or wake trigger.
pub(super) enum Source<'a> {
    Message(&'a CommandMessage),
    Trigger(&'a CommandTrigger),
}

/// The admission fields shared by run and wake commands.
pub(super) struct Fresh<'a> {
    pub(super) turn_id: &'a str,
    pub(super) session_id: &'a str,
    pub(super) trigger_key: &'a str,
    pub(super) source: Source<'a>,
    pub(super) model_selection: &'a CommandModelSelection,
    pub(super) progress_destination: Option<&'a ProgressDestination>,
    pub(super) context: &'a Value,
}

impl<'a> Fresh<'a> {
    /// The admission fields of a run or wake; a resume admits nothing.
    pub(super) fn of(command: &'a TurnCommand) -> Option<Self> {
        match command {
            TurnCommand::Run(run) => Some(Self {
                turn_id: &run.turn_id,
                session_id: &run.session_id,
                trigger_key: &run.trigger_key,
                source: Source::Message(&run.message),
                model_selection: &run.model_selection,
                progress_destination: run.progress_destination.as_ref(),
                context: &run.context,
            }),
            TurnCommand::Wake(wake) => Some(Self {
                turn_id: &wake.turn_id,
                session_id: &wake.session_id,
                trigger_key: &wake.trigger_key,
                source: Source::Trigger(&wake.trigger),
                model_selection: &wake.model_selection,
                progress_destination: wake.progress_destination.as_ref(),
                context: &wake.context,
            }),
            TurnCommand::Resume(_) => None,
        }
    }

    /// The admitted message or trigger id.
    pub(super) fn message_id(&self) -> StorageResult<&'a str> {
        match self.source {
            Source::Message(message) => text(&message.message_id, "messageId"),
            Source::Trigger(trigger) => text(&trigger.trigger_id, "triggerId"),
        }
    }

    /// The admitted message or trigger content.
    pub(super) fn content(&self) -> StorageResult<&'a str> {
        match self.source {
            Source::Message(message) => text(&message.content, "content"),
            Source::Trigger(trigger) => text(&trigger.content, "content"),
        }
    }
}

/// Decodes a stored command.
pub(super) fn decode(command_json: &str) -> StorageResult<TurnCommand> {
    serde_json::from_str(command_json).map_err(|source| {
        StorageError::new(StorageCode::InvalidTurnCommand, source.to_string()).with_source(source)
    })
}

/// A required, non-empty command text.
pub(super) fn text<'a>(value: &'a str, key: &str) -> StorageResult<&'a str> {
    if value.is_empty() {
        return Err(error(
            StorageCode::InvalidTurnCommand,
            format!("missing text: {key}"),
        ));
    }
    Ok(value)
}
