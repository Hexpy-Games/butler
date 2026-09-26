//! Immutable selection and fresh mutation authority for Cognition generations.

mod authority;
mod cache;
mod cutover;
mod initialize;
mod native_bind;
mod qualification;
mod qualification_service;
mod qualification_witness;
mod read;
mod rebuild;
mod reconcile;
mod repair_inputs;
mod retry_failed;
mod set_extractor;
mod types;

pub(crate) use authority::assert_mutation_authority;
pub(crate) use cache::advance as advance_rebuild_cache;
pub(in crate::cognition) use cache::physical_entries as physical_hot_cache_entries;
pub(in crate::cognition) use cache::read_hot_cache_health;
pub(crate) use cutover::{
    activate as activate_memory_rebuild, rollback as rollback_memory_rebuild,
};
pub(crate) use initialize::initialize_empty_memory_generation;
pub(crate) use native_bind::bind_native_embedding_identity;
pub(crate) use qualification_service::validate as validate_memory_rebuild;
pub(crate) use read::{
    active_memory_descriptor_exists, resolve_active_generation, resolve_generation,
    resolve_projection_generation,
};
pub(crate) use rebuild::refresh_memory_rebuild_snapshot;
pub(crate) use rebuild::{
    BuildInventory, assert_rebuild_sources_registered, read_build_inventory, rebuild_typed_cursor,
};
pub(crate) use rebuild::{compute_rebuild_readiness, record_rebuild_readiness};
pub(crate) use rebuild::{inspect as inspect_memory_rebuild, prepare as prepare_memory_rebuild};
pub(crate) use reconcile::run as reconcile_rebuild_vector_representatives;
pub(crate) use repair_inputs::{
    CandidateInputRepairRequest, run as repair_memory_candidate_inputs,
};
pub(crate) use retry_failed::run as retry_failed_memory_generation;
pub(crate) use set_extractor::run as set_extractor_memory_generation;
pub(crate) use types::{GenerationEmbedding, MemoryGenerationHandle, MemoryGenerationTarget};

#[cfg(test)]
mod tests;
