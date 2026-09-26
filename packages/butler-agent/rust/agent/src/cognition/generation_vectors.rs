//! Physical Lance rows for an explicitly native, current memory generation.
//! Every operation owns its bounded connection and table lifetime.

mod adapter;
mod compatibility;
mod readiness;
mod representative;
mod rows;
mod search;

pub(crate) use adapter::NativeGenerationVectorAdapter;
pub(crate) use readiness::invalid_persisted_rebuild_vectors;
pub(crate) use representative::{PreparedRepresentative, prepare_representatives};
pub(crate) use rows::{GenerationVectorRow, NativeGenerationVectorStore, persisted_receipt};
