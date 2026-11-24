use serde::{Deserialize, Serialize};

use crate::backup::{BackupError, PIECE, scope};

#[derive(Deserialize, Serialize)]
pub struct Manifest {
    pub format: u32,
    pub created_at: String,
    pub app_version: String,
    pub total_bytes: u64,
    pub files: Vec<FileEntry>,
}

#[derive(Deserialize, Serialize)]
pub struct FileEntry {
    pub path: String,
    pub size: u64,
    pub kind: Kind,
    pub chunks: Vec<String>,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    File,
    Sqlite,
}

pub fn validate(manifest: &Manifest) -> Result<(), BackupError> {
    let mut paths = std::collections::HashSet::new();
    let mut total = 0u64;
    for file in &manifest.files {
        if !scope::allowed(&file.path)
            || !paths.insert(&file.path)
            || file.size.div_ceil(PIECE as u64) != file.chunks.len() as u64
            || file.chunks.iter().any(|id| {
                id.len() != 64
                    || !id
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
        {
            return Err(BackupError::ManifestInvalid);
        }
        total = total
            .checked_add(file.size)
            .ok_or(BackupError::ManifestInvalid)?;
    }
    if manifest.format != 1 || total != manifest.total_bytes {
        return Err(BackupError::ManifestInvalid);
    }
    Ok(())
}
