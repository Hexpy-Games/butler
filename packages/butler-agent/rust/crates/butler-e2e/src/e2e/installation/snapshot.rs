//! Read-only copies owned by the harness, shared across test processes.
use std::{
    fs::{self, File, OpenOptions},
    io,
    path::{Path, PathBuf},
    sync::OnceLock,
};

use butler_platform::command_sandbox::FixtureInstallation;
use sha2::{Digest, Sha256};

use super::super::{HarnessError, binary, harness_error};
use super::Access;

static SOURCES: OnceLock<Result<Sources, String>> = OnceLock::new();

struct Sources {
    entries: Vec<(PathBuf, PathBuf)>,
    cache: PathBuf,
    key: String,
}

/// Holds the publication lock until all scenario links have been created.
/// Removing an old snapshot afterwards cannot affect those linked inodes.
pub struct Snapshot {
    path: PathBuf,
    _lock: File,
}

impl Snapshot {
    pub fn install(&self, target: &Path) -> io::Result<()> {
        super::link_tree(&self.path, target)
    }
}

/// Scan source metadata once per process. Across nextest processes, only the
/// publisher copies bytes; every other process reuses the atomic directory.
pub fn prepare() -> Result<Snapshot, HarnessError> {
    let sources = SOURCES
        .get_or_init(|| Sources::locate().map_err(|error| error.to_string()))
        .as_ref()
        .map_err(harness_error)?;
    fs::create_dir_all(&sources.cache)?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(sources.cache.join("publish.lock"))?;
    lock.lock()?;
    let path = sources.cache.join(&sources.key);
    if !path.is_dir() {
        publish(sources, &path)?;
    }
    // Also collect abandoned staging directories after a publisher crashes.
    for entry in fs::read_dir(&sources.cache)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() && entry.path() != path {
            FixtureInstallation::remove_sandbox(&entry.path())?;
        }
    }
    Ok(Snapshot { path, _lock: lock })
}

impl Sources {
    fn locate() -> Result<Self, HarnessError> {
        let source = binary::agent_binary()?;
        let binary = fs::canonicalize(&source)?;
        let resources = fs::canonicalize(binary::resource_source())?;
        let mut namespace = Sha256::new();
        namespace.update(binary.as_os_str().as_encoded_bytes());
        namespace.update([0]);
        namespace.update(resources.as_os_str().as_encoded_bytes());
        let mut entries = vec![(
            binary.clone(),
            Path::new("bin").join(format!("butler-agent{}", std::env::consts::EXE_SUFFIX)),
        )];
        if let Some(helper) = FixtureInstallation::command_helper() {
            entries.push((source.with_file_name(helper), Path::new("bin").join(helper)));
        }
        collect(&resources, Path::new("resources"), &mut entries)?;
        entries.sort_by(|a, b| a.1.cmp(&b.1));
        let key = identity(&entries)?;
        Ok(Self {
            entries,
            cache: std::env::temp_dir()
                .join("butler-e2e/snapshots")
                .join(format!("{:x}", namespace.finalize())),
            key,
        })
    }
}

fn collect(
    source: &Path,
    relative: &Path,
    entries: &mut Vec<(PathBuf, PathBuf)>,
) -> io::Result<()> {
    entries.push((source.to_owned(), relative.to_owned()));
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let relative = relative.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            collect(&entry.path(), &relative, entries)?;
        } else if entry.file_type()?.is_file() {
            entries.push((entry.path(), relative));
        }
    }
    Ok(())
}

fn identity(entries: &[(PathBuf, PathBuf)]) -> io::Result<String> {
    let mut hash = Sha256::new();
    for (source, relative) in entries {
        let metadata = fs::metadata(source)?;
        hash.update(relative.as_os_str().as_encoded_bytes());
        hash.update([0]);
        hash.update(format!(
            "{:?}:{}:{:?}\n",
            butler_platform::secure_fs::identity(&metadata),
            metadata.len(),
            metadata.permissions(),
        ));
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn publish(sources: &Sources, target: &Path) -> io::Result<()> {
    let staging = sources
        .cache
        .join(format!(".staging-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&staging)?;
    let result = (|| {
        for (source, relative) in &sources.entries {
            let destination = staging.join(relative);
            if source.is_dir() {
                fs::create_dir_all(destination)?;
            } else {
                fs::create_dir_all(
                    destination
                        .parent()
                        .ok_or_else(|| io::Error::other("no parent"))?,
                )?;
                super::install(source, &destination, Access::Immutable)?;
            }
        }
        let index = staging.join("resources/app-client/dist/index.html");
        if !index.exists() {
            fs::create_dir_all(
                index
                    .parent()
                    .ok_or_else(|| io::Error::other("no index parent"))?,
            )?;
            fs::write(&index, "<!doctype html><title>e2e</title>")?;
            let mut permissions = fs::metadata(&index)?.permissions();
            permissions.set_readonly(true);
            fs::set_permissions(index, permissions)?;
        }
        // Reject a source build that changed while its snapshot was copied.
        if identity(&sources.entries)? != sources.key {
            return Err(io::Error::other(
                "installation sources changed during snapshot publication",
            ));
        }
        fs::rename(&staging, target)
    })();
    if result.is_err() {
        let _ = FixtureInstallation::remove_sandbox(&staging);
    }
    result
}
