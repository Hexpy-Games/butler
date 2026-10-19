//! Operation-owned canonical Conversation source reads for Profile and Cognition.

mod reader;
mod scalar;

pub use reader::{
    Archived, CanonicalMemoryReadBinding, ConversationSourceReader, MessageOrigins, PageOrder,
    PublicMemoryScope, PublicMemorySnapshot, PublicSessionRow, RecallOutcomeRow, SourceChange,
    SourceChangeKind,
};
pub use scalar::{ConversationScalar, decode_message_scalars, scalar_for_part};

#[cfg(test)]
mod tests;
