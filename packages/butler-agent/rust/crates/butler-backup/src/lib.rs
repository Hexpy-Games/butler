//! Encrypted backup engine: recovery key, sealed chunks, manifest, backup
//! scope, page-wise SQLite reads, local state and restore staging. See
//! [`backup`]. No HTTP and no async runtime; callers block on
//! `spawn_blocking`.

pub mod backup;
