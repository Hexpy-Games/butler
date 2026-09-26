use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::Value;

const MAX_ENTRIES: usize = 500;

pub(crate) trait DeveloperLogWriteAuthority: Send + Sync {
    /// Revalidates the captured DATA/installation boundary immediately before mutation.
    fn authorize(&self, destination: &Path) -> io::Result<()>;
}

pub(crate) struct DeveloperLogStore {
    data_root: PathBuf,
    authority: Arc<dyn DeveloperLogWriteAuthority>,
    mutation: Mutex<()>,
}

impl DeveloperLogStore {
    pub(crate) fn new(data_root: PathBuf, authority: Arc<dyn DeveloperLogWriteAuthority>) -> Self {
        Self {
            data_root,
            authority,
            mutation: Mutex::new(()),
        }
    }

    pub(crate) fn append(&self, entry: &Value) -> io::Result<()> {
        let _guard = self
            .mutation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let destination = self.path();
        self.authority.authorize(&destination)?;
        self.ensure_parent(&destination)?;
        reject_symlink(&destination)?;

        let mut line = serde_json::to_vec(entry)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        line.push(b'\n');
        let mut file = append_file(&destination)?;
        file.write_all(&line)?;
        secure_mode(&destination)?;
        self.enforce_retention(&destination)
    }

    fn path(&self) -> PathBuf {
        self.data_root
            .join("app")
            .join("developer-logs")
            .join("model-turns.jsonl")
    }

    fn ensure_parent(&self, destination: &Path) -> io::Result<()> {
        let parent = destination
            .parent()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing log parent"))?;
        reject_existing_directory_symlinks(&self.data_root, parent)?;
        fs::create_dir_all(parent)?;
        let metadata = fs::symlink_metadata(parent)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "developer log directory is not a real directory",
            ));
        }
        secure_directory_mode(parent)
    }

    fn enforce_retention(&self, destination: &Path) -> io::Result<()> {
        self.authority.authorize(destination)?;
        reject_symlink(destination)?;
        let count = match count_entries(destination) {
            Ok(count) => count,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        if count <= MAX_ENTRIES {
            return Ok(());
        }

        let temporary = temporary_path(destination);
        reject_existing_directory_symlinks(
            &self.data_root,
            temporary
                .parent()
                .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing log parent"))?,
        )?;
        self.authority.authorize(&temporary)?;
        reject_symlink(&temporary)?;
        let output = open_private_temporary(&temporary)?;
        let mut cleanup = TemporaryPath::new(temporary.clone());
        let mut reader = BufReader::new(open_read_no_follow(destination)?);
        let mut writer = BufWriter::new(output);
        let first_retained = count - MAX_ENTRIES;
        let mut seen = 0usize;
        let mut record = String::new();

        loop {
            record.clear();
            if reader.read_line(&mut record)? == 0 {
                break;
            }
            let retained = record.trim();
            if retained.is_empty() {
                continue;
            }
            if seen >= first_retained {
                writer.write_all(retained.as_bytes())?;
                writer.write_all(b"\n")?;
            }
            seen += 1;
        }

        writer.flush()?;
        writer.get_ref().sync_all()?;
        drop(writer);
        self.authority.authorize(destination)?;
        reject_existing_directory_symlinks(
            &self.data_root,
            destination
                .parent()
                .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing log parent"))?,
        )?;
        reject_symlink(destination)?;
        reject_symlink(&temporary)?;
        fs::rename(&temporary, destination)?;
        cleanup.commit();
        Ok(())
    }
}

fn reject_existing_directory_symlinks(root: &Path, parent: &Path) -> io::Result<()> {
    let relative = parent.strip_prefix(root).map_err(|_| {
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            "developer log escaped DATA",
        )
    })?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "developer log parent is not a real directory",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => break,
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn reject_symlink(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "developer log is not a regular file",
            ))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn append_file(path: &Path) -> io::Result<fs::File> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(nix::libc::O_NOFOLLOW);
    }
    options.open(path)
}

fn open_read_no_follow(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(nix::libc::O_NOFOLLOW);
    }
    options.open(path)
}

fn count_entries(path: &Path) -> io::Result<usize> {
    let mut reader = BufReader::new(open_read_no_follow(path)?);
    let mut record = String::new();
    let mut count = 0usize;
    loop {
        record.clear();
        if reader.read_line(&mut record)? == 0 {
            break;
        }
        if !record.trim().is_empty() {
            count = count.saturating_add(1);
        }
    }
    Ok(count)
}

fn temporary_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .expect("fixed developer log path has a file name")
        .to_string_lossy();
    path.with_file_name(format!(".{name}.retain-{}.tmp", uuid::Uuid::new_v4()))
}

fn open_private_temporary(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(nix::libc::O_NOFOLLOW);
    }
    options.open(path)
}

struct TemporaryPath {
    path: PathBuf,
    committed: bool,
}

impl TemporaryPath {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            committed: false,
        }
    }

    fn commit(&mut self) {
        self.committed = true;
    }
}

impl Drop for TemporaryPath {
    fn drop(&mut self) {
        if !self.committed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[cfg(unix)]
fn secure_directory_mode(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn secure_directory_mode(_: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn secure_mode(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn secure_mode(_: &Path) -> io::Result<()> {
    Ok(())
}
