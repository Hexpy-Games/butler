//! Per-scenario sandbox: installation root, data dir `D`, workspace `W`, and a
//! private `HOME`/`CODEX_HOME` so the owner's `~/.butler` and `~/.codex` are
//! never read or written.

use butler_platform::secure_fs::Canonical as _;
use std::fs;
use std::path::{Path, PathBuf};

use super::binary::{agent_binary, resource_source};
mod retention;
use super::executable;
use super::{HarnessError, harness_error};
pub use retention::FAILURE_LIMIT;

pub struct Sandbox {
    pub root: PathBuf,
    pub install: PathBuf,
    pub binary: PathBuf,
    pub resources: PathBuf,
    pub data: PathBuf,
    pub workspace: PathBuf,
    pub home: PathBuf,
    pub logs: PathBuf,
    directory: retention::Directory,
}

impl Sandbox {
    /// Creates a fresh sandbox under the system temp dir. The directory is
    /// removed on success; the last five failures are retained and printed.
    pub fn new(scenario: &str) -> Result<Self, HarnessError> {
        let base = std::env::temp_dir().join("butler-e2e");
        fs::create_dir_all(&base)?;
        // Canonical path: macOS temp dirs are symlinks, and the product resolves them.
        let base = base.canonical()?;
        let root = create_root(&base, scenario)?;
        let directory = retention::Directory {
            path: root.clone(),
            success: false,
        };
        let install = root.join("install");
        let resources = install.join("resources");
        let binary = install
            .join("bin")
            .join(format!("butler-agent{}", std::env::consts::EXE_SUFFIX));
        fs::create_dir_all(install.join("bin"))?;
        // A copy (an APFS clone), never a hard link: macOS reports a process's
        // executable (proc_pidpath) under the name its file was last looked
        // up by, so sandboxes sharing one inode see each other's paths, and
        // the product's instance identity check then refuses the CLI's
        // gateway control requests (`gateway_control_identity_invalid`).
        let source = agent_binary()?;
        executable::copy(&source, &binary).map_err(|error| {
            harness_error(format!(
                "copy E2E agent {} to {}: {error}",
                source.display(),
                binary.display()
            ))
        })?;
        copy_tree(&resource_source(), &resources)?;
        fs::create_dir_all(resources.join("app-client/dist"))?;
        fs::write(
            resources.join("app-client/dist/index.html"),
            "<!doctype html><title>e2e</title>",
        )?;
        let sandbox = Self {
            data: root.join("data"),
            workspace: root.join("workspace"),
            home: root.join("home"),
            logs: root.join("logs"),
            root,
            install,
            binary,
            resources,
            directory,
        };
        for dir in [
            &sandbox.data,
            &sandbox.workspace,
            &sandbox.logs,
            &sandbox.home.join(".codex"),
        ] {
            fs::create_dir_all(dir)?;
        }
        Ok(sandbox)
    }

    /// Call only after every assertion and fallible teardown has succeeded.
    pub fn mark_success(&mut self) {
        self.directory.success = true;
    }

    pub fn codex_home(&self) -> PathBuf {
        self.home.join(".codex")
    }

    /// Byte-level snapshot of the installation dir (relative path, size, hash)
    /// used to prove the product never writes into it.
    pub fn installation_fingerprint(&self) -> Result<Vec<(String, u64, String)>, HarnessError> {
        let mut entries = Vec::new();
        fingerprint(&self.install, &self.install, &mut entries)?;
        entries.sort();
        Ok(entries)
    }
}

fn create_root(base: &Path, scenario: &str) -> Result<PathBuf, HarnessError> {
    for _ in 0..16 {
        let root = base.join(format!(
            "{}-{}",
            scenario.to_lowercase(),
            uuid::Uuid::new_v4().simple()
        ));
        match fs::create_dir(&root) {
            Ok(()) => return Ok(root),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
    Err(harness_error(
        "could not allocate a unique E2E sandbox directory",
    ))
}

pub fn copy_tree(from: &Path, to: &Path) -> Result<(), HarnessError> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn fingerprint(
    root: &Path,
    dir: &Path,
    out: &mut Vec<(String, u64, String)>,
) -> Result<(), HarnessError> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .display()
            .to_string();
        if entry.file_type()?.is_dir() {
            out.push((format!("{relative}/"), 0, String::new()));
            fingerprint(root, &path, out)?;
        } else {
            let metadata = entry.metadata()?;
            // Large files (the linked binary) are compared by size and mtime.
            let digest = if metadata.len() > 8 * 1024 * 1024 {
                format!("{:?}", metadata.modified().ok())
            } else {
                super::sha256_hex(&fs::read(&path)?)
            };
            out.push((relative, metadata.len(), digest));
        }
    }
    Ok(())
}
