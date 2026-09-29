//! The installed Agent: versions side by side in the Agent home, one active
//! through `current`, one kept for rollback.
//!
//! ```text
//! AGENT_HOME/
//!   <version>-<sha8>/   butler-agent, butler -> butler-agent, resources/,
//!                       native-agent-manifest.json (an extracted archive)
//!   current  -> <version>-<sha8>      the active version
//!   previous -> <version>-<sha8>      where `rollback` returns to
//!   .install.lock                     held while the home changes
//! ```
//!
//! Everything that changes the home holds [`HomeLock`], so concurrent
//! `update`, `install`, `rollback` and `uninstall` runs queue behind the
//! `install_busy` error instead of interleaving.

mod archive;
mod digest;
mod launcher;
mod layout;
mod manifest;
mod removal;
mod transaction;

pub use digest::{sha256_file, sha256_tree};
pub use launcher::{LauncherPaths, LauncherState, LauncherSync};
pub use layout::{AgentHome, BINARY, InstalledVersion, RESOURCES, version_dir_name};
pub use removal::HomeRemoval;
pub use transaction::{Activated, HomeLock, Installed, Switched};
