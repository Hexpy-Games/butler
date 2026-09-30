//! Agent archives built on the spot for the install scenarios: a
//! `butler.native-agent-install.v1` archive around the binary under test,
//! the update manifest that offers it, and hostile archives.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use butler_platform::secure_fs::{self, FileMode};
use flate2::Compression;
use flate2::write::GzEncoder;
use sha2::{Digest, Sha256};
use tar::{Builder, EntryType, Header};

use super::executable;
use super::{HarnessError, harness_error};

/// A built archive and what its manifest says about it.
pub struct Archive {
    pub path: PathBuf,
    /// SHA-256 of the archive file.
    pub sha256: String,
    pub version: String,
    /// The version directory it installs into, `<version>-<sha8>`.
    pub dir: String,
}

/// Builds `butler-agent-<version>.tar.gz` in `out_dir`: `binary` as
/// `butler-agent`, the `butler` link, a copy of `resources`, and the manifest
/// with the digests the installer verifies. Versions built from one binary
/// differ by version only, so their directories differ as well.
pub fn build_archive(
    out_dir: &Path,
    version: &str,
    binary: &Path,
    resources: &Path,
) -> Result<Archive, HarnessError> {
    write_archive(out_dir, version, binary, resources)
}

/// [`build_archive`] around a tiny stand-in executable that differs per
/// `version` and `tag` and a two-file resource tree: the installer only
/// hashes and unpacks what it installs, so scenarios that never start the
/// installed Agent need not carry a real binary.
pub fn build_stub_archive(
    out_dir: &Path,
    version: &str,
    tag: &str,
) -> Result<Archive, HarnessError> {
    stub(out_dir, version, tag, 0)
}

/// [`build_stub_archive`] whose executable exits with status 1: an update to
/// it installs, and the restart onto it fails.
pub fn build_failing_archive(
    out_dir: &Path,
    version: &str,
    tag: &str,
) -> Result<Archive, HarnessError> {
    stub(out_dir, version, tag, 1)
}

fn stub(out_dir: &Path, version: &str, tag: &str, status: u8) -> Result<Archive, HarnessError> {
    let stage = out_dir.join(format!("stub-{version}-{tag}"));
    fs::create_dir_all(stage.join("resources/nested"))?;
    let binary = stage.join("butler-agent");
    executable::write_script(
        &binary,
        &format!("#!/bin/sh\n# {version} {tag}\nexit {status}\n"),
    )?;
    fs::write(stage.join("resources/a.txt"), "a")?;
    fs::write(stage.join("resources/nested/b.txt"), "b")?;
    let archive = write_archive(out_dir, version, &binary, &stage.join("resources"))?;
    fs::remove_dir_all(&stage)?;
    Ok(archive)
}

fn write_archive(
    out_dir: &Path,
    version: &str,
    binary: &Path,
    resources: &Path,
) -> Result<Archive, HarnessError> {
    fs::create_dir_all(out_dir)?;
    let started = std::time::Instant::now();
    let binary_sha = file_sha256(binary)?;
    let resources_sha = tree_sha256(resources)?;
    let hash_elapsed = started.elapsed();
    let (platform, architecture) = host_platform();
    let manifest = serde_json::json!({
        "schema": "butler.native-agent-install.v1",
        "version": version,
        "appVersion": null,
        "platform": platform,
        "architecture": architecture,
        "binary": "butler-agent",
        "resources": "resources",
        "launcher": "butler",
        "binarySha256": binary_sha,
        "resourcesSha256": resources_sha,
    });
    let path = out_dir.join(format!(
        "butler-agent-{version}-{}.tar.gz",
        &binary_sha[..8]
    ));
    let mut builder = Builder::new(GzEncoder::new(File::create(&path)?, Compression::fast()));
    let mut header = Header::new_gnu();
    header.set_size(fs::metadata(binary)?.len());
    header.set_mode(FileMode::EXECUTABLE.bits());
    builder.append_data(&mut header, "butler-agent", File::open(binary)?)?;
    let mut link = Header::new_gnu();
    link.set_entry_type(EntryType::Symlink);
    link.set_size(0);
    link.set_mode(FileMode::EXECUTABLE.bits());
    builder.append_link(&mut link, "butler", "butler-agent")?;
    builder.append_dir_all("resources", resources)?;
    let manifest = serde_json::to_vec_pretty(&manifest)?;
    let mut header = Header::new_gnu();
    header.set_size(manifest.len() as u64);
    header.set_mode(FileMode::ORDINARY.bits());
    builder.append_data(
        &mut header,
        "native-agent-manifest.json",
        manifest.as_slice(),
    )?;
    builder.into_inner()?.finish()?.flush()?;
    let sha256 = file_sha256(&path)?;
    eprintln!(
        "install fixture {version}: binary_bytes={} hash={hash_elapsed:?} total={:?}",
        fs::metadata(binary)?.len(),
        started.elapsed()
    );
    Ok(Archive {
        sha256,
        path,
        version: version.to_owned(),
        dir: format!("{version}-{}", &binary_sha[..8]),
    })
}

/// Makes every file and directory under `root` read-only, as an unpacked
/// release archive leaves them (children first, so each directory is still
/// searchable while its entries change).
pub fn make_read_only(root: &Path) -> Result<(), HarnessError> {
    for entry in fs::read_dir(root)? {
        let path = entry?.path();
        if fs::symlink_metadata(&path)?.is_dir() {
            make_read_only(&path)?;
        } else {
            secure_fs::set_file_mode(&path, FileMode::READ_ONLY).transpose()?;
        }
    }
    secure_fs::set_file_mode(root, FileMode::READ_ONLY_DIRECTORY).transpose()?;
    Ok(())
}

/// The `<os>-<arch>` label of this host's release artifact.
pub fn release_platform() -> String {
    butler_platform::launcher::release_platform()
}

/// Writes an update manifest with one artifact per `(platform, archive)`;
/// a platform of `None` leaves the artifact unlabelled.
pub fn write_update_manifest(
    path: &Path,
    artifacts: &[(Option<String>, &Archive)],
) -> Result<(), HarnessError> {
    let artifacts: Vec<_> = artifacts
        .iter()
        .map(|(platform, archive)| {
            let mut artifact = serde_json::json!({
                "component": "service",
                "canonical_component": "agent",
                "product": "butler-agent",
                "profile": "agent-standalone",
                "version": archive.version,
                "channel": "stable",
                "artifact_url": archive.path,
                "sha256": archive.sha256,
                "integrity": {"digestAlgorithm": "sha256", "digest": archive.sha256, "signature": null},
                "bundled_components": ["service"],
                "protocol_compatibility": {
                    "protocol": "butler.agent.v1",
                    "minimumAgentProtocol": "butler.agent.v1",
                    "maximumAgentProtocol": "butler.agent.v1"
                },
                "update_policy": "explicit",
                "restart_policy": "restart-service",
                "updater_owner": "butler-agent",
                "payload_format": "agent-archive",
                "staging_policy": "butler-data-updates",
                "activation_policy": "butler-managed",
                "rollback_policy": "supported",
            });
            if let Some(platform) = platform {
                artifact["platform"] = platform.clone().into();
            }
            artifact
        })
        .collect();
    let newest = artifacts
        .last()
        .and_then(|artifact| artifact["version"].as_str())
        .unwrap_or_default()
        .to_owned();
    let manifest = serde_json::json!({
        "schema": "butler.update-manifest.v1",
        "product": "butler-agent",
        "agent_version": newest,
        "artifacts": artifacts,
    });
    fs::write(path, serde_json::to_vec_pretty(&manifest)?)?;
    Ok(())
}

/// One entry of a hostile archive, written without the checks the tar
/// library applies to paths (so `..` and absolute names get through).
pub struct RawEntry<'a> {
    pub name: &'a str,
    pub kind: EntryType,
    pub link: Option<&'a str>,
    pub data: &'a [u8],
}

/// Writes a gzip tar of `entries` exactly as given.
pub fn hostile_archive(path: &Path, entries: &[RawEntry<'_>]) -> Result<(), HarnessError> {
    let mut builder = Builder::new(GzEncoder::new(File::create(path)?, Compression::fast()));
    for entry in entries {
        let mut header = Header::new_gnu();
        let gnu = header
            .as_gnu_mut()
            .ok_or_else(|| harness_error("not a GNU header"))?;
        let name = entry.name.as_bytes();
        gnu.name
            .get_mut(..name.len())
            .ok_or_else(|| harness_error("entry name too long"))?
            .copy_from_slice(name);
        if let Some(link) = entry.link {
            let link = link.as_bytes();
            gnu.linkname
                .get_mut(..link.len())
                .ok_or_else(|| harness_error("link name too long"))?
                .copy_from_slice(link);
        }
        header.set_entry_type(entry.kind);
        header.set_size(entry.data.len() as u64);
        header.set_mode(FileMode::ORDINARY.bits());
        header.set_cksum();
        builder.append(&header, entry.data)?;
    }
    builder.into_inner()?.finish()?.flush()?;
    Ok(())
}

/// The install-manifest names of this host: `darwin`/`linux`, `arm64`/`x64`.
fn host_platform() -> (String, String) {
    let label = release_platform();
    let (platform, architecture) = label.split_once('-').unwrap_or((&label, ""));
    (platform.to_owned(), architecture.to_owned())
}

pub fn file_sha256(path: &Path) -> Result<String, HarnessError> {
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    std::io::copy(&mut file, &mut digest)?;
    Ok(hex(&digest.finalize()))
}

/// The resource-tree digest of the install manifest: entries sorted by name,
/// each as a `d:`, `f:` or `l:` line, files followed by their bytes.
pub fn tree_sha256(root: &Path) -> Result<String, HarnessError> {
    let mut digest = Sha256::new();
    tree_into(&mut digest, root, "")?;
    Ok(hex(&digest.finalize()))
}

fn tree_into(digest: &mut Sha256, directory: &Path, relative: &str) -> Result<(), HarnessError> {
    let mut entries: Vec<_> = fs::read_dir(directory)?.collect::<Result<_, _>>()?;
    entries.sort_by_key(fs::DirEntry::file_name);
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let label = if relative.is_empty() {
            name
        } else {
            format!("{relative}/{name}")
        };
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            let target = fs::read_link(entry.path())?;
            digest.update(format!("l:{label}:{}\n", target.display()).as_bytes());
        } else if kind.is_dir() {
            digest.update(format!("d:{label}\n").as_bytes());
            tree_into(digest, &entry.path(), &label)?;
        } else {
            digest.update(format!("f:{label}\n").as_bytes());
            digest.update(fs::read(entry.path())?);
        }
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes
        .iter()
        .fold(String::with_capacity(64), |mut out, byte| {
            let _ = write!(out, "{byte:02x}");
            out
        })
}
