use butler_platform::secure_fs;
use parking_lot::Mutex;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;

const MAX_ENTRIES: usize = 500;
const TRIM_THRESHOLD: usize = 600;

pub trait DeveloperLogWriteAuthority: Send + Sync {
    /// Revalidates the captured DATA/installation boundary immediately before mutation.
    fn authorize(&self, destination: &Path) -> io::Result<()>;
}

pub struct DeveloperLogStore {
    data_root: PathBuf,
    authority: Arc<dyn DeveloperLogWriteAuthority>,
    mutation: Mutex<Option<RetentionState>>,
}

struct RetentionState {
    count: usize,
    metadata: fs::Metadata,
}

impl RetentionState {
    fn matches(&self, current: &fs::Metadata) -> bool {
        self.metadata.len() == current.len()
            && secure_fs::identity(&self.metadata) == secure_fs::identity(current)
    }
}

impl DeveloperLogStore {
    pub fn new(data_root: PathBuf, authority: Arc<dyn DeveloperLogWriteAuthority>) -> Self {
        Self {
            data_root,
            authority,
            mutation: Mutex::new(None),
        }
    }

    pub(crate) fn append(&self, entry: &Value) -> io::Result<()> {
        let mut state = self.mutation.lock();
        let destination = self.path();
        self.authority.authorize(&destination)?;
        self.ensure_parent(&destination)?;
        reject_symlink(&destination)?;

        let metadata = match fs::metadata(&destination) {
            Ok(value) => Some(value),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error),
        };
        let count = match (state.take(), metadata.as_ref()) {
            (Some(previous), Some(current)) if previous.matches(current) => previous.count,
            (_, Some(_)) => count_entries(&destination)?,
            (_, None) => 0,
        };
        let mut line = serde_json::to_vec(entry)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        line.push(b'\n');
        let mut file = append_file(&destination)?;
        file.write_all(&line)?;
        secure_mode(&destination)?;
        drop(file);
        let count = self.enforce_retention(&destination, count.saturating_add(1))?;
        *state = Some(RetentionState {
            count,
            metadata: fs::metadata(&destination)?,
        });
        Ok(())
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

    fn enforce_retention(&self, destination: &Path, count: usize) -> io::Result<usize> {
        self.authority.authorize(destination)?;
        reject_symlink(destination)?;
        if count <= TRIM_THRESHOLD {
            return Ok(count);
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
        Ok(MAX_ENTRIES)
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
    let _ = secure_fs::owner_only(&mut options);
    let _ = secure_fs::no_follow(&mut options);
    options.open(path)
}

fn open_read_no_follow(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    secure_fs::no_follow(&mut options);
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
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    path.with_file_name(format!(".{name}.retain-{}.tmp", uuid::Uuid::new_v4()))
}

fn open_private_temporary(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    let _ = secure_fs::owner_only(&mut options);
    let _ = secure_fs::no_follow(&mut options);
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

/// Hosts without owner-only permissions keep the directory as it is.
fn secure_directory_mode(path: &Path) -> io::Result<()> {
    secure_fs::restrict_directory(path).unwrap_or(Ok(()))
}

/// Hosts without owner-only permissions keep the file as it is.
fn secure_mode(path: &Path) -> io::Result<()> {
    secure_fs::restrict_file(path).unwrap_or(Ok(()))
}

#[cfg(test)]
pub(super) fn retention_regression() {
    struct Allowed;
    impl DeveloperLogWriteAuthority for Allowed {
        fn authorize(&self, _: &Path) -> io::Result<()> {
            Ok(())
        }
    }
    let root = std::env::temp_dir().join(format!("developer-retention-{}", uuid::Uuid::new_v4()));
    let store = DeveloperLogStore::new(root.clone(), Arc::new(Allowed));
    let path = store.path();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let row =
        |index: usize| serde_json::json!({"payload": format!("{index:04}{}", "x".repeat(4092))});
    let line = format!("{}\n", row(0));
    let rows = |range: std::ops::Range<usize>| {
        use std::fmt::Write as _;
        let mut output = String::new();
        for index in range {
            writeln!(&mut output, "{}", row(index)).unwrap();
        }
        output
    };
    fs::write(&path, rows(0..500)).unwrap();
    let mut bytes_written = 0;
    let mut counts = Vec::new();
    for turn in 0..101 {
        let before = fs::metadata(&path).unwrap();
        store.append(&row(500 + turn)).unwrap();
        let after = fs::metadata(&path).unwrap();
        // An atomic rewrite changes file identity; count appended bytes plus the output.
        bytes_written += line.len() as u64;
        if !butler_platform::secure_fs::same_file(&before, &after) {
            bytes_written += after.len();
        }
        if turn == 0 {
            eprintln!("developer-log first-full-turn bytes={bytes_written}");
        }
        counts.push(count_entries(&path).unwrap());
    }
    eprintln!(
        "developer-log bytes/turn={} total={} turns=101",
        bytes_written / 101,
        bytes_written
    );
    let expected: Vec<_> = (0..101)
        .map(|turn| if turn == 100 { 500 } else { 501 + turn })
        .collect();
    assert_eq!(counts, expected, "retention needs hysteresis");
    assert_eq!(fs::read_to_string(&path).unwrap(), rows(101..601));
    fs::write(&path, rows(1000..1600)).unwrap();
    store.append(&row(1600)).unwrap();
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        rows(1101..1601),
        "external replacement must invalidate count"
    );
    fs::remove_dir_all(root).unwrap();
}
