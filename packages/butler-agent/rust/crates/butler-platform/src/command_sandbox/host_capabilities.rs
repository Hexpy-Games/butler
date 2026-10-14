//! Cached host boundaries. Probing must never restrict the agent's own thread.
use std::sync::OnceLock;

/// Strength of an independently enforced command boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    /// The host kernel enforces this boundary.
    Enforced,
    /// Some access remains outside this boundary.
    Partial(&'static str),
    /// The boundary cannot be installed on this host.
    Unavailable(&'static str),
}

impl Level {
    /// Whether the boundary is fully enforced.
    pub fn is_enforced(self) -> bool {
        matches!(self, Self::Enforced)
    }
}

/// Host command boundaries, probed once per process without idle work.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SandboxCapabilities {
    /// File content and metadata writes, including truncation and device ioctls.
    pub read_only: Level,
    /// External sockets of any family; anonymous local stream pairs may be allowed.
    pub network_deny: Level,
    /// Signals and abstract Unix sockets cannot reach processes outside the sandbox.
    pub process_scoping: Level,
    /// Credential roots and project secret names.
    pub private_reads: Level,
    /// Legacy protected installation roots.
    pub write_protection: Level,
    /// Project mutations, with post-run cleanup on hosts with name limitations.
    pub project_write: Level,
}

impl SandboxCapabilities {
    /// Whether project mutations can run without exact-action approval.
    pub fn project_write_available(&self) -> bool {
        matches!(self.project_write, Level::Enforced | Level::Partial(_))
            && self.read_only.is_enforced()
            && self.network_deny.is_enforced()
    }

    /// Linux top-level secret protection complements the existing lexical guard.
    pub fn approval_free_reads(&self) -> bool {
        self.read_only.is_enforced()
            && self.network_deny.is_enforced()
            && matches!(self.private_reads, Level::Enforced | Level::Partial(_))
    }
}

/// Returns the cached host probe. Unsupported hosts retain approval fallback.
pub fn capabilities() -> &'static SandboxCapabilities {
    static CAPABILITIES: OnceLock<SandboxCapabilities> = OnceLock::new();
    CAPABILITIES.get_or_init(probe)
}

fn probe() -> SandboxCapabilities {
    #[cfg(target_os = "macos")]
    return SandboxCapabilities {
        read_only: Level::Enforced,
        network_deny: Level::Enforced,
        process_scoping: Level::Unavailable("process scoping is not probed on macOS"),
        private_reads: Level::Enforced,
        write_protection: Level::Enforced,
        project_write: Level::Enforced,
    };
    #[cfg(target_os = "linux")]
    return super::linux::probe();
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    unavailable("no command sandbox on this host")
}

#[cfg(not(target_os = "macos"))]
pub(super) fn unavailable(reason: &'static str) -> SandboxCapabilities {
    SandboxCapabilities {
        read_only: Level::Unavailable(reason),
        network_deny: Level::Unavailable(reason),
        process_scoping: Level::Unavailable(reason),
        private_reads: Level::Unavailable(reason),
        write_protection: Level::Unavailable(reason),
        project_write: Level::Unavailable(reason),
    }
}
