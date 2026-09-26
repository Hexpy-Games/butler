use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};

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
    pub(super) open_file: Option<std::fs::File>,
}

impl TemporarySpool {
    pub(super) fn create(data_root: &Path) -> io::Result<Self> {
        fs::create_dir_all(data_root)?;
        let root = data_root.canonicalize()?;
        let tmp = root.join("tmp");
        let spool_dir = tmp.join("web-access-spool");
        create_private_directory(&tmp)?;
        create_private_directory(&spool_dir)?;
        let path = spool_dir.join(format!("{}.body", uuid::Uuid::new_v4()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let open_file = options.open(&path)?;
        Ok(Self {
            path,
            open_file: Some(open_file),
        })
    }

    pub(super) fn from_bytes(data_root: &Path, bytes: &[u8]) -> io::Result<Self> {
        let mut spool = Self::create(data_root)?;
        let mut file = spool.open_file.take().expect("new spool file");
        file.write_all(bytes)?;
        file.sync_all()?;
        Ok(spool)
    }
}

impl Drop for TemporarySpool {
    fn drop(&mut self) {
        drop(self.open_file.take());
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
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = fs::DirBuilder::new();
        match builder.mode(0o700).create(path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
    #[cfg(not(unix))]
    match fs::create_dir(path) {
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

#[cfg(test)]
mod tests {
    use super::create_private_directory;
    use std::fs;

    #[test]
    fn spool_parent_refuses_symlink_aliases() {
        let root = std::env::temp_dir().join(format!("web-spool-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let outside = root.join("outside");
        fs::create_dir(&outside).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, root.join("alias")).unwrap();
        #[cfg(unix)]
        assert!(create_private_directory(&root.join("alias")).is_err());
        let _ = fs::remove_dir_all(root);
    }
}
