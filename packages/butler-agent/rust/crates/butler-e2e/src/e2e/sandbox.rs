//! Per-scenario sandbox: installation root, data dir `D`, workspace `W`, and a
//! private `HOME`/`CODEX_HOME` so the owner's `~/.butler` and `~/.codex` are
//! never read or written.

use std::fs;
use std::path::{Path, PathBuf};

use super::HarnessError;
use super::binary::{agent_binary, resource_source};
use super::config::flag;

pub struct Sandbox {
    pub root: PathBuf,
    pub install: PathBuf,
    pub binary: PathBuf,
    pub resources: PathBuf,
    pub data: PathBuf,
    pub workspace: PathBuf,
    pub home: PathBuf,
    pub logs: PathBuf,
    keep: bool,
}

impl Sandbox {
    /// Creates a fresh sandbox under the system temp dir. The directory is
    /// removed on drop unless `BUTLER_E2E_KEEP_DATA=1`.
    pub fn new(scenario: &str) -> Result<Self, HarnessError> {
        let base = std::env::temp_dir().join("butler-e2e");
        fs::create_dir_all(&base)?;
        // Canonical path: macOS temp dirs are symlinks, and the product resolves them.
        let base = base.canonicalize()?;
        let root = base.join(format!(
            "{}-{}",
            scenario.to_lowercase(),
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        ));
        let install = root.join("install");
        let resources = install.join("resources");
        let binary = install.join("bin/butler-agent");
        fs::create_dir_all(install.join("bin"))?;
        let source = agent_binary()?;
        if fs::hard_link(&source, &binary).is_err() {
            fs::copy(&source, &binary)?;
        }
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
            keep: flag("BUTLER_E2E_KEEP_DATA"),
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

impl Drop for Sandbox {
    fn drop(&mut self) {
        if self.keep {
            eprintln!("BUTLER_E2E_KEEP_DATA: kept {}", self.root.display());
        } else {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
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
