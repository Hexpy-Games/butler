//! Immutable selection and fresh mutation authority for Cognition generations.

mod authority;
mod cache;
mod cutover;
mod initialize;
mod qualification;
mod qualification_service;
mod qualification_witness;
mod read;
mod rebuild;
mod reconcile;
mod repair_inputs;
mod retry_failed;
mod set_extractor;
mod stage;
mod types;

pub use crate::cognition::generation::embedding_binding::bind_native_embedding_identity;
pub use authority::assert_mutation_authority;
pub use cache::advance as advance_rebuild_cache;
pub(in crate::cognition) use cache::{
    physical_entries as physical_hot_cache_entries, read_hot_cache_health,
};
pub use cutover::{
    CutoverStamp, activate as activate_memory_rebuild, rollback as rollback_memory_rebuild,
};
pub use initialize::initialize_empty_memory_generation;
pub use qualification_service::validate as validate_memory_rebuild;
pub(crate) use read::resolve_projection_generation;
pub use read::{active_memory_descriptor_exists, resolve_active_generation, resolve_generation};
pub use rebuild::refresh_memory_rebuild_snapshot;
pub use rebuild::{
    BuildInventory, assert_rebuild_sources_registered, read_build_inventory, rebuild_typed_cursor,
};
pub use rebuild::{compute_rebuild_readiness, record_rebuild_readiness};
pub use rebuild::{inspect as inspect_memory_rebuild, prepare as prepare_memory_rebuild};
pub use reconcile::run as reconcile_rebuild_vector_representatives;
pub use repair_inputs::{CandidateInputRepairRequest, run as repair_memory_candidate_inputs};
pub use retry_failed::run as retry_failed_memory_generation;
pub use set_extractor::run as set_extractor_memory_generation;
pub use types::{GenerationEmbedding, MemoryGenerationHandle, MemoryGenerationTarget};

mod embedding_binding;
#[cfg(test)]
mod format_pin;
#[cfg(test)]
mod tests;
