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
//! - [`browser_process`]: a Chromium process tree driven over the DevTools
//!   pipe.
//! - [`app_browser`]: the installed App's Electron, found and run without a
//!   window as a browser host.
//! - [`process_priority`]: background scheduling priority for long CPU work.
//! - [`process_control`]: process groups, group signals, exit signals,
//!   liveness, detached processes and the stop requests a service receives.
//! - [`instance`]: the instance lock, host facts, process identity and
//!   stopping another instance.
//! - [`command_sandbox`]: the shells commands run in and the sandbox that
//!   enforces read-only and write-protected access.
//! - [`secure_fs`]: owner-only files and directories, atomic replacement,
//!   no-follow opens, directory exchange and file identity.
//! - [`system_wake`]: change-driven OS sleep/wake notifications.
//! - [`time_zone`]: IANA time zone rules by name.
//! - [`user_dirs`]: the user's home, the Agent home and the command
//!   directory, and the system's own folders.
//! - [`launcher`]: runnable programs and the release platform tag.
//! - [`command_launcher`]: the user's `butler` command (a launcher file
//!   that runs the installed Agent) and who owns a file at that path.
//! - [`install_link`]: the `current` and `previous` pointers of an Agent
//!   home, switched atomically.
//! - [`service_registration`]: login-time start of the service (launchd,
//!   systemd `--user`, Task Scheduler).
//! - [`network`]: the machine's own interface addresses.
//! - [`cpu`]: how many performance cores the machine has.
//! - [`memory`]: how much physical memory the machine has.
//! - [`desktop`]: whether a browser can open, and opening a link in it.
//! - [`download_mark`]: the downloaded-from-the-internet mark (quarantine,
//!   Mark-of-the-Web) on a file another app opens.
//! - [`sqlite`]: file database opens with the host's path-capable VFS.
//! - [`stdio`]: this process's stdin and stdout as one async stream.
//! - [`browser_profiles`]: other browsers' profiles and bookmark files, for import.
//! - [`agent_homes`]: other AI agents' instruction and configuration files, for import.
//! - [`user_auth`]: asking the user to verify themselves (Touch ID, Windows
//!   Hello or the account password) before a secret is shown.
//!
//! macOS and Linux implement the behavior Butler shipped with. Windows
//! implements what the service needs to run and stop (process identity,
//! Job Object containment, host facts); a capability it does not have yet
//! has a probe (such as [`command_sandbox::capabilities`]) and reports
//! `None` or a typed `Unsupported` error instead of pretending to succeed.

// Production code reads slices and strings with checked accessors.
#![deny(clippy::indexing_slicing)]
// Every public item says what it is for.
#![deny(missing_docs)]

pub mod account_dirs;
pub mod agent_homes;
pub mod app_browser;
pub mod app_update;
pub mod browser_process;
pub mod browser_profiles;
pub mod browser_transfer;
pub mod change_notifications;
pub mod command_launcher;
pub mod command_sandbox;
pub mod cpu;
pub mod data_paths;
pub mod desktop;
pub mod download_mark;
pub mod fs_space;
pub mod install_link;
pub mod instance;
pub mod launcher;
pub mod memory;
pub mod network;
pub mod process_control;
pub mod process_names;
pub mod process_priority;
pub mod secrets;
pub mod secure_fs;
pub mod service_registration;
pub mod shared_locks;
pub mod sqlite;
pub mod stdio;
pub mod storage_size;
pub mod system_wake;
pub mod time_zone;
pub mod tool_paths;
pub mod user_auth;
pub mod user_dirs;

#[cfg(windows)]
mod process_table;

pub mod hook_process;

pub mod preview_process;

pub mod plugin_files;
