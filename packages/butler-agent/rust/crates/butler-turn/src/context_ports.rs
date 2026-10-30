//! Ports of Context assembly that collaborators below the runtime implement:
//! the profile prompt section, memory source references, and the failures
//! they report.

mod error;
mod memory_source;
mod prompt;

pub use error::{ContextCode, ContextError};
pub use memory_source::{MemorySourceCandidate, MemorySourceReferencePort, ResolvedMemorySource};
pub use prompt::{ContextFuture, ProfilePromptPort, PromptProjectionInput};

pub type ContextResult<T> = Result<T, ContextError>;
