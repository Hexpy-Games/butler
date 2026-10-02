//! Immutable selection and fresh mutation authority for Cognition generations.

mod authority;
pub(in crate::cognition) mod cache;
mod initialize;
mod manifest;
mod read;
mod stage;
pub(in crate::cognition) mod swap;
mod types;

pub use crate::cognition::generation::embedding_binding::bind_native_embedding_identity;
pub use authority::assert_mutation_authority;
pub use cache::advance as advance_rebuild_cache;
pub(in crate::cognition) use cache::{
    HotCacheEntryView, HotCacheHealth, physical_entries as physical_hot_cache_entries,
    read_hot_cache_health,
};
pub use initialize::{
    FreshMemoryGeneration, initialize_empty_memory_generation, prepare_fresh_memory_generation,
};
pub use manifest::{
    AcceptanceBinding, ActiveDescriptor, CanonicalSnapshot, EmbeddingSlot, GenerationFormat,
    GenerationManifest, GenerationReadiness, GenerationState, InitializationOrigin, ProjectionMode,
    SemanticCounts, StageCounts,
};
pub(crate) use read::resolve_projection_generation;
pub use read::{active_memory_descriptor_exists, resolve_active_generation, resolve_generation};
pub use types::{GenerationEmbedding, MemoryGenerationHandle, MemoryGenerationTarget};

mod embedding_binding;
#[cfg(test)]
mod format_pin;
#[cfg(test)]
mod tests;
