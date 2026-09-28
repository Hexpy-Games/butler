//! The operating-system boundary of Butler.
//!
//! Every operating-system specific decision lives in this crate, so the rest
//! of the workspace has no per-OS code: no `cfg(unix)`, `cfg(windows)` or
//! `cfg(target_os)`, no `std::os::*`, `nix`, `libc`, `libproc` or `rustix`,
//! no raw permission bits and no `HOME` lookups. Other crates call the
//! platform-neutral functions here; `tools/source-check` enforces this with a
//! ratchet that may only shrink (see each crate's `os-specific-baseline.txt`).
//!
//! Each domain keeps one neutral facade with `unix` and `windows`
//! implementations beside it:
//!
//! - [`process_control`]: process groups, group signals, exit signals and
//!   liveness.
//! - [`instance`]: the exclusive instance lock, host name and process
//!   identity.
//! - [`command_sandbox`]: the shells commands run in and the sandbox that
//!   enforces read-only and write-protected access.
//! - [`secure_fs`]: owner-only files and directories, atomic replacement,
//!   no-follow opens, directory exchange and file identity.
//! - [`user_dirs`]: the user's home directory.
//! - [`service_registration`] and [`launcher`]: the interfaces of the
//!   per-user service definition and the `butler` command launcher.
//!
//! macOS and Linux implement the behavior Butler shipped with. Windows
//! compiles, and a capability it does not have yet reports a typed
//! `Unsupported` error (or an explicit capability flag) instead of guessing.

// Production code reads slices and strings with checked accessors.
#![deny(clippy::indexing_slicing)]
// Every public item says what it is for.
#![deny(missing_docs)]

pub mod command_sandbox;
pub mod instance;
pub mod launcher;
pub mod process_control;
pub mod secure_fs;
pub mod service_registration;
pub mod user_dirs;
