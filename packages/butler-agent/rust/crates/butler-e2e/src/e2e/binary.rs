//! Locates (and by default builds) the `butler-agent` executable under test.
//!
//! `BUTLER_E2E_BIN` selects a prebuilt binary. Otherwise the harness runs
//! `cargo build -p butler-agent --bin butler-agent` once per test process, so
//! `cargo test -p butler-e2e` (and `cargo mutants` using it) always exercises
//! the binary built from the current sources. `BUTLER_E2E_SKIP_BUILD=1` uses
//! the existing workspace binary without rebuilding.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use super::config::{flag, nonempty};
use super::{HarnessError, harness_error};

static BINARY: OnceLock<Result<PathBuf, String>> = OnceLock::new();

pub fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// `packages/butler-agent/resources` as shipped next to the binary.
pub fn resource_source() -> PathBuf {
    workspace_root().join("../resources")
}

pub fn agent_binary() -> Result<PathBuf, HarnessError> {
    BINARY.get_or_init(locate).clone().map_err(harness_error)
}

fn locate() -> Result<PathBuf, String> {
    if let Some(path) = nonempty("BUTLER_E2E_BIN") {
        let path = PathBuf::from(path);
        return if path.is_file() {
            Ok(path)
        } else {
            Err(format!("BUTLER_E2E_BIN does not exist: {}", path.display()))
        };
    }
    let profile = if cfg!(debug_assertions) {
        "debug"
    } else {
        "release"
    };
    let target = nonempty("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| workspace_root().join("target"));
    let binary = target.join(profile).join("butler-agent");
    if !flag("BUTLER_E2E_SKIP_BUILD") {
        let cargo = nonempty("CARGO").unwrap_or_else(|| "cargo".into());
        let mut command = Command::new(cargo);
        command.current_dir(workspace_root()).args([
            "build",
            "--quiet",
            "-p",
            "butler-agent",
            "--bin",
            "butler-agent",
        ]);
        if profile == "release" {
            command.arg("--release");
        }
        let status = command
            .status()
            .map_err(|error| format!("cannot run cargo build for butler-agent: {error}"))?;
        if !status.success() {
            return Err(format!("cargo build -p butler-agent failed: {status}"));
        }
    }
    if binary.is_file() {
        Ok(binary)
    } else {
        Err(format!(
            "butler-agent binary missing at {}; build it or set BUTLER_E2E_BIN",
            binary.display()
        ))
    }
}
