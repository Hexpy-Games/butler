//! Actual Profile source facts from the canonical Conversation database.
//! Bootstrap opens the canonical writer/schema before constructing this factory.

use std::path::PathBuf;

use butler_memory::profile::{
    CanonicalProfileMessage, CanonicalProfilePart, CanonicalProfileScalar, CanonicalProfileScan,
    CanonicalProfileSourceFactory, CanonicalProfileSourceReader, ProfileError, ProfileResult,
};
use butler_turn::conversation::{
    ConversationError, ConversationMessageWithParts, ConversationOriginKind, ConversationReadOrder,
    ConversationRole, ConversationSourceReader, ReadCognitionMessagesInput, decode_message_scalars,
};

pub(crate) struct ProfileConversationSources {
    path: PathBuf,
}

impl ProfileConversationSources {
    pub(crate) fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl CanonicalProfileSourceFactory for ProfileConversationSources {
    fn open(&self) -> ProfileResult<Box<dyn CanonicalProfileSourceReader>> {
        let reader = ConversationSourceReader::open(&self.path).map_err(source_error)?;
        Ok(Box::new(ProfileSourceRead {
            reader,
            root: self
                .path
                .parent()
                .and_then(std::path::Path::parent)
                .ok_or_else(|| {
                    ProfileError::port(
                        "profile_source_unavailable",
                        "Invalid source path",
                        std::io::Error::other("Invalid source path"),
                    )
                })?
                .to_owned(),
        }))
    }
}

struct ProfileSourceRead {
    root: PathBuf,
    reader: ConversationSourceReader,
}

impl CanonicalProfileSourceReader for ProfileSourceRead {
    fn read_cognition_messages(
        &mut self,
        scan: CanonicalProfileScan,
    ) -> ProfileResult<Vec<CanonicalProfileMessage>> {
        if let Some(ids) = butler_memory::profile::admitted_profile_message_ids(&self.root, &scan)?
        {
            return ids
                .into_iter()
                .filter_map(|id| match self.reader.read_message(&id) {
                    Ok(Some(message)) => Some(Ok(project_message(message))),
                    Ok(None) => None,
                    Err(error) => Some(Err(source_error(error))),
                })
                .collect();
        }
        self.reader
            .read_cognition_messages(&ReadCognitionMessagesInput {
                session_id: None,
                roles: vec![ConversationRole::User],
                since: scan.since,
                limit: Some(scan.limit),
                offset: Some(scan.offset),
                include_compacted: true,
                order: Some(ConversationReadOrder::Asc),
            })
            .map(|messages| messages.into_iter().map(project_message).collect())
            .map_err(source_error)
    }

    fn read_message(&mut self, id: &str) -> ProfileResult<Option<CanonicalProfileMessage>> {
        if !butler_memory::profile::profile_message_is_admitted(&self.root, id)? {
            return Ok(None);
        }
        self.reader
            .read_message(id)
            .map(|message| message.map(project_message))
            .map_err(source_error)
    }

    fn close(self: Box<Self>) -> ProfileResult<()> {
        self.reader.close().map_err(source_error)
    }
}

fn project_message(message: ConversationMessageWithParts) -> CanonicalProfileMessage {
    let mut scalars = decode_message_scalars(&message).into_iter().peekable();
    let mut parts = Vec::with_capacity(message.parts.len());
    for part in &message.parts {
        let mut projected = Vec::new();
        while let Some(scalar) = scalars.next_if(|scalar| std::ptr::eq(scalar.part, part)) {
            projected.push(CanonicalProfileScalar {
                pointer: scalar.pointer,
                source_hash: scalar.hash,
                text: scalar.text.to_owned(),
            });
        }
        parts.push(CanonicalProfilePart {
            part_id: part.id.clone(),
            part_index: part.part_index as f64,
            scalars: projected,
        });
    }
    drop(scalars);
    CanonicalProfileMessage {
        id: message.message.id,
        session_id: message.message.session_id,
        role: role_name(message.message.role).into(),
        origin_kind: origin_name(message.message.origin_kind).into(),
        created_at: message.message.created_at,
        parts,
    }
}

fn role_name(role: ConversationRole) -> &'static str {
    match role {
        ConversationRole::System => "system",
        ConversationRole::Developer => "developer",
        ConversationRole::User => "user",
        ConversationRole::Assistant => "assistant",
        ConversationRole::Tool => "tool",
    }
}

fn origin_name(origin: ConversationOriginKind) -> &'static str {
    match origin {
        ConversationOriginKind::UserInput => "user_input",
        ConversationOriginKind::AssistantPublic => "assistant_public",
        ConversationOriginKind::InternalControl => "internal_control",
        ConversationOriginKind::Unknown => "unknown",
    }
}

/// Profile cannot name Conversation errors; they cross the port with their
/// own code and message and stay the source.
fn source_error(error: ConversationError) -> ProfileError {
    ProfileError::port(error.code(), error.message(), error)
}

#[cfg(test)]
mod tests;
