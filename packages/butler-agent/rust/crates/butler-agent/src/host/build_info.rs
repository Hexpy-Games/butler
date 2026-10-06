//! Immutable executable provenance, supplied by the thin binary at startup.

use std::sync::OnceLock;

/// Values embedded by the executable's build script, independent of host code.
#[derive(Clone, Copy, Debug)]
pub struct BuildInfo {
    /// Product version selected from the release tag, or the development version.
    pub version: &'static str,
    /// Source revision and dirty marker used by lifecycle diagnostics.
    pub build_id: &'static str,
}

static BUILD_INFO: OnceLock<BuildInfo> = OnceLock::new();

pub(super) fn initialize(info: BuildInfo) {
    // An executable enters once. Reentrant library callers retain that identity.
    let _ = BUILD_INFO.set(info);
}

pub(super) fn current() -> BuildInfo {
    BUILD_INFO.get().copied().unwrap_or(BuildInfo {
        version: concat!(env!("CARGO_PKG_VERSION"), "-dev"),
        build_id: "source-archive",
    })
}
