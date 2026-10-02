//! Shared mutable DATA authority, mapped to Cognition's public error contract.
use super::{CognitionCode, CognitionError, CognitionResult};
use std::path::Path;
/// Checks that every path remains inside mutable DATA.
pub fn ensure_data_authority(root: &Path, descendants: &[&Path]) -> CognitionResult<()> {
    crate::coordination::ensure_data_authority(root, descendants).map_err(|source| {
        CognitionError::new(
            CognitionCode::MemoryDataPathUnsafe,
            "Cognition path is outside mutable DATA",
        )
        .with_source(source)
    })
}
