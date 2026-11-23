use crate::backup::{scope, state::write_json};
use serde::{Deserialize, Serialize};
use std::{fs, io, path::Path};

#[derive(Deserialize, Serialize)]
pub struct Receipt {
    pub format: u32,
    pub created_at: String,
    pub total_bytes: u64,
    pub verified: bool,
}

pub fn write_receipt(staging: &Path, receipt: &Receipt) -> io::Result<()> {
    write_json(&staging.join("receipt.json"), receipt)
}

pub fn read_receipt(staging: &Path) -> io::Result<Option<Receipt>> {
    match fs::read(staging.join("receipt.json")) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

pub fn apply_files(root: &Path, staging: &Path, paths: &[String]) -> io::Result<()> {
    for rel in paths {
        if !scope::allowed(rel) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid restore path",
            ));
        }
        let source = staging.join("files").join(rel);
        if !source.try_exists()? {
            continue;
        }
        let target = root.join(rel);
        let parent = target
            .parent()
            .ok_or_else(|| io::Error::other("restore file has no parent"))?;
        let mut ancestor = root.to_path_buf();
        for component in Path::new(rel)
            .parent()
            .into_iter()
            .flat_map(Path::components)
        {
            ancestor.push(component);
            if fs::symlink_metadata(&ancestor).is_ok_and(|meta| meta.is_symlink()) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "linked restore directory",
                ));
            }
        }
        butler_platform::secure_fs::create_private_dir_all(parent)?;
        let sidecars: &[&str] = if scope::is_sqlite(&source)? {
            &["-wal", "-shm", "-journal"]
        } else {
            &[]
        };
        for suffix in sidecars.iter().copied().chain([""]) {
            match fs::remove_file(root.join(format!("{rel}{suffix}"))) {
                Ok(()) => (),
                Err(error) if error.kind() == io::ErrorKind::NotFound => (),
                Err(error) => return Err(error),
            }
        }
        butler_platform::secure_fs::rename(&source, &target)?;
        if let Some(sync) = butler_platform::secure_fs::sync_directory(parent) {
            sync?;
        }
    }
    Ok(())
}
