mod key;
mod manifest;
mod read;
mod scope;
mod seal;
mod staging;
mod state;

pub use key::{BackupKey, Subkeys, parse_recovery};
pub use manifest::{FileEntry, Kind, Manifest, validate as validate_manifest};
pub use read::pieces;
pub use scope::{active_generation, allowed, is_sqlite, walk};
pub use seal::{chunk_id, open_chunk, open_manifest, seal_chunk, seal_manifest};
pub use staging::{Receipt, apply_files, read_receipt, write_receipt};
pub use state::{CachedFile, LocalState, Slot, Usage, unreferenced, write_json};

pub const PIECE: usize = 4 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum BackupError {
    #[error("recovery_key_invalid")]
    RecoveryKeyInvalid,
    #[error("recovery_key_wrong")]
    RecoveryKeyWrong,
    #[error("chunk_corrupt")]
    ChunkCorrupt,
    #[error("manifest_invalid")]
    ManifestInvalid,
    #[error("io")]
    Io(#[from] std::io::Error),
}
