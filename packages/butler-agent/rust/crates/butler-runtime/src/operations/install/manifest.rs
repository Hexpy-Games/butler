//! The `butler.native-agent-install.v1` manifest of an extracted archive and
//! the checks that make an extracted tree a version worth switching to.

use std::fs;
use std::path::Path;

use butler_platform::{install_link, launcher};
use serde_json::Value;

use super::digest::{sha256_file, sha256_tree};
use super::layout::{BINARY, RESOURCES, version_dir_name};
use crate::operations::update::{UpdateCode, UpdateError};

/// The manifest's file name, beside the executable.
pub(super) const MANIFEST_FILE: &str = "native-agent-manifest.json";
const SCHEMA: &str = "butler.native-agent-install.v1";
const COMMAND_LINK: &str = "butler";
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_VERSION_BYTES: usize = 64;

/// The fields of the manifest the installer relies on.
#[derive(Clone, Debug)]
pub(super) struct InstallManifest {
    /// The Agent version.
    pub(super) version: String,
    /// `darwin` or `linux`.
    pub(super) platform: String,
    /// `arm64` or `x64`.
    pub(super) architecture: String,
    /// SHA-256 of the executable.
    pub(super) binary_sha256: String,
    /// SHA-256 of the resource tree.
    pub(super) resources_sha256: String,
}

impl InstallManifest {
    /// The version directory this installation belongs in.
    pub(super) fn dir_name(&self) -> String {
        version_dir_name(&self.version, &self.binary_sha256)
    }
}

/// Reads and validates the manifest in `dir`; hashes nothing.
///
/// # Errors
///
/// `install_manifest_invalid` for a missing, oversized, aliased or malformed
/// manifest.
pub(super) fn read_manifest(dir: &Path) -> Result<InstallManifest, UpdateError> {
    let invalid = || UpdateError::from(UpdateCode::InstallManifestInvalid);
    let path = dir.join(MANIFEST_FILE);
    let metadata = fs::symlink_metadata(&path).map_err(|_| invalid())?;
    if !metadata.is_file() || metadata.len() > MAX_MANIFEST_BYTES {
        return Err(invalid());
    }
    let value: Value =
        serde_json::from_slice(&fs::read(&path).map_err(|_| invalid())?).map_err(|_| invalid())?;
    for (field, expected) in [
        ("schema", SCHEMA),
        ("binary", BINARY),
        ("resources", RESOURCES),
        ("launcher", COMMAND_LINK),
    ] {
        if value[field].as_str() != Some(expected) {
            return Err(invalid());
        }
    }
    let version = text(&value, "version")
        .filter(|version| safe_version(version))
        .ok_or_else(invalid)?;
    let digest = |field: &str| text(&value, field).filter(|digest| sha256_shaped(digest));
    Ok(InstallManifest {
        version,
        platform: text(&value, "platform").ok_or_else(invalid)?,
        architecture: text(&value, "architecture").ok_or_else(invalid)?,
        binary_sha256: digest("binarySha256").ok_or_else(invalid)?,
        resources_sha256: digest("resourcesSha256").ok_or_else(invalid)?,
    })
}

/// Checks that `dir` is a complete installation for this host: the manifest,
/// the executable and resource digests it records, and the `butler` link.
///
/// # Errors
///
/// `install_manifest_invalid`, `install_platform_mismatch` or
/// `install_verification_failed`.
pub(super) fn verify_installation(dir: &Path) -> Result<InstallManifest, UpdateError> {
    let manifest = read_manifest(dir)?;
    let target = format!("{}-{}", manifest.platform, manifest.architecture);
    if target != launcher::release_platform() {
        return Err(UpdateCode::InstallPlatformMismatch.into());
    }
    let failed = || UpdateError::from(UpdateCode::InstallVerificationFailed);
    let binary = dir.join(BINARY);
    let metadata = fs::symlink_metadata(&binary).map_err(|_| failed())?;
    if !launcher::is_executable(&binary, &metadata) {
        return Err(failed());
    }
    let link = fs::read_link(dir.join(COMMAND_LINK)).map_err(|_| failed())?;
    if link != Path::new(BINARY) {
        return Err(failed());
    }
    let binary_digest = sha256_file(&binary).map_err(|_| failed())?;
    let resources_digest = sha256_tree(&dir.join(RESOURCES)).map_err(|_| failed())?;
    if binary_digest != manifest.binary_sha256 || resources_digest != manifest.resources_sha256 {
        return Err(failed());
    }
    Ok(manifest)
}

fn text(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// A version that is one plain directory-name component.
fn safe_version(version: &str) -> bool {
    version.len() <= MAX_VERSION_BYTES
        && install_link::is_plain_name(version)
        && !version.starts_with('.')
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-'))
}

fn sha256_shaped(digest: &str) -> bool {
    digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
