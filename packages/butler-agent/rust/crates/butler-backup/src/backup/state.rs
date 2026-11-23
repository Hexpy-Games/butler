use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    fs, io,
    path::Path,
};

#[derive(Deserialize, Serialize)]
pub struct LocalState {
    pub format: u32,
    pub enabled: bool,
    pub next_slot: u8,
    pub last_success_at: Option<String>,
    pub last_error: Option<String>,
    pub usage: Usage,
    pub files: BTreeMap<String, CachedFile>,
    pub slots: Vec<Slot>,
}

#[derive(Default, Deserialize, Serialize)]
pub struct Usage {
    pub used_bytes: u64,
    pub quota_bytes: u64,
}

#[derive(Deserialize, Serialize)]
pub struct CachedFile {
    pub size: u64,
    pub mtime_ms: u64,
    pub wal_size: u64,
    pub wal_mtime_ms: u64,
    pub chunks: Vec<String>,
}

#[derive(Clone, Deserialize, PartialEq, Serialize)]
pub struct Slot {
    pub slot: u8,
    pub version: u64,
    pub created_at: String,
    pub chunks: Vec<String>,
}

impl Default for LocalState {
    fn default() -> Self {
        Self {
            format: 1,
            enabled: false,
            next_slot: 0,
            last_success_at: None,
            last_error: None,
            usage: Usage::default(),
            files: BTreeMap::new(),
            slots: Vec::new(),
        }
    }
}

impl LocalState {
    pub fn load(root: &Path) -> io::Result<Self> {
        match fs::read(root.join("backup/state.json")) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Self::default()),
            Err(error) => Err(error),
        }
    }

    pub fn save(&self, root: &Path) -> io::Result<()> {
        write_json(&root.join("backup/state.json"), self)
    }
}

pub fn write_json(path: &Path, value: &impl Serialize) -> io::Result<()> {
    butler_platform::secure_fs::create_private_dir_all(
        path.parent()
            .ok_or_else(|| io::Error::other("missing JSON file parent"))?,
    )?;
    butler_platform::secure_fs::replace_private(
        path,
        |file| Ok(serde_json::to_writer(file, value)?),
        std::convert::identity,
    )
}

pub fn unreferenced(old: &[String], live: &[Slot]) -> Vec<String> {
    let retained: HashSet<_> = live.iter().flat_map(|slot| &slot.chunks).collect();
    let mut found = HashSet::new();
    old.iter()
        .filter(|id| !retained.contains(id) && found.insert(*id))
        .cloned()
        .collect()
}
