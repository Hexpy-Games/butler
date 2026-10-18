//! The durable reset intent contains identifiers and paths, never secret values.
use butler_platform::secure_fs;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

pub(crate) const JOURNAL: &str = "state/full-reset.json";
pub(crate) const GENERATION: &str = "state/data-generation";
pub(crate) const TRASH_PREFIX: &str = ".reset-trash-";
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SecretId {
    pub service: String,
    pub account: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Phase {
    Requested,
    RollingBack,
    Failed,
    Applied,
    Cleaned,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Journal {
    pub schema: u32,
    pub id: String,
    pub phase: Phase,
    pub created_at: String,
    pub secret_keys: Vec<SecretId>,
    pub project_hot_caches: Vec<PathBuf>,
    pub moves: Vec<PathBuf>,
    pub old_generation: String,
    pub new_generation: String,
    pub retried: bool,
}
impl Journal {
    pub(crate) fn trash(&self, root: &Path) -> PathBuf {
        root.join(format!("{TRASH_PREFIX}{}", self.id))
    }
    pub(crate) fn save(&self, root: &Path) -> io::Result<()> {
        secure_fs::replace_private(
            &root.join(JOURNAL),
            |f| serde_json::to_writer(f, self).map_err(io::Error::other),
            |e| e,
        )
    }
}
pub(crate) fn load(root: &Path) -> io::Result<Option<Journal>> {
    let file = match secure_fs::open_read_beneath(root, Path::new(JOURNAL)) {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let journal: Journal = serde_json::from_reader(file).map_err(io::Error::other)?;
    if journal.schema != 1
        || !super::valid_id(&journal.id)
        || journal.moves.iter().any(|p| !super::plan::movable(p))
    {
        return Err(io::Error::other("Invalid reset journal"));
    }
    Ok(Some(journal))
}
pub(crate) fn remove(root: &Path) -> io::Result<()> {
    fs::remove_file(root.join(JOURNAL))?;
    sync(&root.join("state"))
}
pub(crate) fn sync(path: &Path) -> io::Result<()> {
    secure_fs::sync_directory(path).unwrap_or(Ok(()))
}
pub(crate) fn generation(root: &Path) -> io::Result<String> {
    match secure_fs::open_read_beneath(root, Path::new(GENERATION)) {
        Ok(mut f) => {
            let mut value = String::new();
            f.read_to_string(&mut value)?;
            Ok(value)
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => create_generation(root),
        Err(e) => Err(e),
    }
}
pub(crate) fn write_generation(root: &Path, value: &str) -> io::Result<()> {
    secure_fs::replace_private(
        &root.join(GENERATION),
        |f| f.write_all(value.as_bytes()),
        |e| e,
    )
}

fn create_generation(root: &Path) -> io::Result<String> {
    let value = uuid::Uuid::new_v4().to_string();
    let temporary = root
        .join("state")
        .join(format!(".data-generation-{value}.tmp"));
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    secure_fs::owner_only(&mut opts);
    secure_fs::no_follow(&mut opts);
    let mut file = opts.open(&temporary)?;
    let result = (|| {
        secure_fs::restrict_open_file(&file).unwrap_or(Ok(()))?;
        file.write_all(value.as_bytes())?;
        file.sync_all()?;
        drop(file);
        // A hard link atomically publishes complete bytes without clobbering
        // another creator. Both names are in the same private directory.
        match fs::hard_link(&temporary, root.join(GENERATION)) {
            Ok(()) => {
                sync(&root.join("state"))?;
                Ok(value)
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => generation(root),
            Err(e) => Err(e),
        }
    })();
    fs::remove_file(temporary)?;
    result
}
