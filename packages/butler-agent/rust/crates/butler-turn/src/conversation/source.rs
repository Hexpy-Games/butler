//! Operation-owned canonical Conversation source reads for Profile and Cognition.

mod reader;
mod scalar;

pub use reader::{
    CanonicalMemoryReadBinding, ConversationSourceReader, PublicMemoryScope, PublicMemorySnapshot,
    PublicSessionRow, RecallOutcomeRow,
};
pub use scalar::{ConversationScalar, decode_message_scalars, scalar_for_part};

#[cfg(test)]
mod tests;
