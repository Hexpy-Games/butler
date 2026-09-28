//! The operating-system boundary of Butler.
//!
//! Every operating-system specific decision lives in this crate, so the rest
//! of the workspace has no per-OS code: no `cfg(unix)`, `cfg(windows)` or
//! `cfg(target_os)`, no `std::os::*` or `std::env::consts::OS`, no `nix`,
//! `libc`, `libproc` or `rustix`, no raw permission bits and no `HOME`
//! lookups. Other crates call the platform-neutral functions here;
//! `tools/source-check` enforces this with a ratchet that may only shrink
//! (see each crate's `os-specific-baseline.txt`).
//!
//! Each domain keeps one neutral facade with `unix` and `windows`
//! implementations beside it:
//!
//! - [`process_control`]: process groups, group signals, exit signals,
//!   liveness, detached processes and the stop requests a service receives.
//! - [`instance`]: the instance lock, host facts, process identity and
//!   stopping another instance.
//! - [`command_sandbox`]: the shells commands run in and the sandbox that
//!   enforces read-only and write-protected access.
//! - [`secure_fs`]: owner-only files and directories, atomic replacement,
//!   no-follow opens, directory exchange and file identity.
//! - [`user_dirs`]: the user's home and the system's own folders.
//! - [`launcher`]: runnable programs and the release platform tag.
//! - [`network`]: the machine's own interface addresses.
//!
//! macOS and Linux implement the behavior Butler shipped with. Windows
//! compiles; a capability it does not have yet has a flag (such as
//! [`secure_fs::OWNER_ONLY`]) and reports `None` or a typed `Unsupported`
//! error instead of pretending to succeed.

// Production code reads slices and strings with checked accessors.
#![deny(clippy::indexing_slicing)]
// Every public item says what it is for.
#![deny(missing_docs)]

pub mod command_sandbox;
pub mod instance;
pub mod launcher;
pub mod network;
pub mod process_control;
pub mod secure_fs;
pub mod user_dirs;
