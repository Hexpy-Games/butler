//! Physical Lance rows for a compatible, current memory generation.
//! Every operation owns its bounded connection and table lifetime.

mod adapter;
pub(crate) mod compatibility;
mod readiness;
mod rows;
mod search;

pub use adapter::GenerationVectorAdapter;
pub(crate) use readiness::invalid_persisted_rebuild_vectors;
pub(crate) use rows::{GenerationVectorRow, GenerationVectorStore, persisted_receipt};
