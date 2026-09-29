use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};

use butler_platform::secure_fs;

pub(super) struct FetchedBody {
    pub(super) final_url: String,
    pub(super) status: u16,
    pub(super) ok: bool,
    pub(super) content_type: Option<String>,
    pub(super) spool: TemporarySpool,
}

impl FetchedBody {
    pub(super) fn read_all(&self) -> io::Result<Vec<u8>> {
        fs::read(&self.spool.path)
    }
}

pub(super) struct TemporarySpool {
    pub(super) path: PathBuf,
}

impl TemporarySpool {
    /// Creates a private spool file and returns it opened for writing.
    pub(super) fn create(data_root: &Path) -> io::Result<(Self, std::fs::File)> {
        fs::create_dir_all(data_root)?;
        let root = data_root.canonicalize()?;
        let tmp = root.join("tmp");
        let spool_dir = tmp.join("web-access-spool");
        create_private_directory(&tmp)?;
        create_private_directory(&spool_dir)?;
        let path = spool_dir.join(format!("{}.body", uuid::Uuid::new_v4()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        secure_fs::owner_only(&mut options);
        let open_file = options.open(&path)?;
        Ok((Self { path }, open_file))
    }

    pub(super) fn from_bytes(data_root: &Path, bytes: &[u8]) -> io::Result<Self> {
        let (spool, mut file) = Self::create(data_root)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        Ok(spool)
    }
}

impl Drop for TemporarySpool {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn create_private_directory(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "unsafe spool directory",
            ));
        }
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    match secure_fs::create_private_dir(path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "unsafe spool directory",
        ));
    }
    Ok(())
}
