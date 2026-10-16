//! Parallel no-follow, zero-access identity walk. No entry-count truncation.
use super::inventory::{self, Inventory};
use crate::command_sandbox::{mxc_policy::WinPath, project_secrets::portable::tree::MAX_DEPTH};
use std::{
    collections::{HashMap, VecDeque},
    ffi::OsString,
    fs, io,
    os::windows::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex},
    thread,
};
use winapi_util::file::{Information, information};
use winsafe::co;
const THREADS: usize = 16;
pub(super) struct Pin {
    _handle: fs::File,
    _parent: Option<Arc<Pin>>,
    pub(super) key: inventory::FileKey,
}
struct Entry {
    path: PathBuf,
    depth: usize,
    secret: Option<PathBuf>,
    parent: Option<Arc<Pin>>,
    directory: bool,
}
struct Queue {
    entries: VecDeque<Entry>,
    active: usize,
    failed: bool,
}

pub(super) fn walk(
    paths: &[PathBuf],
    roots: &[PathBuf],
    protected: &[WinPath],
) -> io::Result<Inventory> {
    if paths.is_empty() {
        return Ok(Inventory::default());
    }
    let queue_phase = super::super::timing::Phase::start("ledger_scan_queue");
    let queue = Mutex::new(Queue {
        entries: entries(paths, roots)?,
        active: 0,
        failed: false,
    });
    drop(queue_phase);
    let changed = Condvar::new();
    let count = thread::available_parallelism()
        .map_or(1, usize::from)
        .min(THREADS);
    thread::scope(|scope| {
        let handles: Vec<_> = (0..count)
            .map(|_| scope.spawn(|| worker(&queue, &changed, roots, protected)))
            .collect();
        let mut inventory = Inventory::default();
        for handle in handles {
            inventory.merge(
                handle
                    .join()
                    .map_err(|_| io::Error::other("ledger scan panic"))??,
            );
        }
        Ok(inventory)
    })
}
fn worker(
    queue: &Mutex<Queue>,
    changed: &Condvar,
    roots: &[PathBuf],
    protected: &[WinPath],
) -> io::Result<Inventory> {
    let mut inventory = Inventory::default();
    loop {
        let mut state = queue
            .lock()
            .map_err(|_| io::Error::other("ledger queue poisoned"))?;
        while state.entries.is_empty() && state.active > 0 && !state.failed {
            state = changed
                .wait(state)
                .map_err(|_| io::Error::other("ledger queue poisoned"))?;
        }
        if state.failed {
            return Err(io::Error::other("ledger scan failed"));
        }
        if state.entries.is_empty() {
            return Ok(inventory);
        }
        // A directory can contain an entire inline file batch. Give it to one
        // worker at a time; batch only leaf candidates to amortize queue locks.
        let count = state
            .entries
            .iter()
            .take(32)
            .take_while(|entry| !entry.directory)
            .count()
            .max(1);
        let batch: Vec<_> = state.entries.drain(..count).collect();
        state.active += 1;
        drop(state);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut children = Vec::new();
            for entry in batch {
                children.extend(visit(entry, roots, protected, &mut inventory)?);
            }
            Ok::<_, io::Error>(children)
        }))
        .unwrap_or_else(|_| Err(io::Error::other("ledger scan panic")));
        let mut state = queue
            .lock()
            .map_err(|_| io::Error::other("ledger queue poisoned"))?;
        state.active -= 1;
        match result {
            Ok(children) => state.entries.extend(children),
            Err(error) => {
                state.failed = true;
                changed.notify_all();
                return Err(error);
            }
        }
        changed.notify_all();
    }
}
fn visit(
    entry: Entry,
    roots: &[PathBuf],
    protected: &[WinPath],
    inventory: &mut Inventory,
) -> io::Result<Vec<Entry>> {
    let Entry {
        path,
        depth,
        secret,
        parent,
        directory,
    } = entry;
    if depth > MAX_DEPTH {
        return Err(io::Error::other("project link discovery depth exceeded"));
    }
    if !directory && !inspect(&path, secret.as_deref(), roots, protected, inventory)? {
        return Ok(Vec::new());
    }
    // The enumeration hint only avoids a redundant open: pin still opens
    // no-follow and validates that this is a directory before it is listed.
    let Some(pinned) = surviving(pin(&path, parent))? else {
        return Ok(Vec::new());
    };
    if let Some(secret) = &secret {
        inventory.secrets.insert(secret.clone());
    }
    let Some(entries) = surviving(fs::read_dir(&path))? else {
        return Ok(Vec::new());
    };
    let entries: Vec<_> = entries.collect();
    if root_identity(&path)? != pinned.key {
        return Err(io::Error::other("ledger directory changed during listing"));
    }
    let inline_files = entries.len() <= 64;
    let mut children = Vec::new();
    for entry in entries {
        let Some(entry) = surviving(entry)? else {
            continue;
        };
        let Some(metadata) = surviving(entry.metadata())? else {
            continue;
        };
        let child = entry.path();
        let child_secret = secret.clone().or_else(|| {
            crate::command_sandbox::secret_name(&entry.file_name().to_string_lossy())
                .then(|| child.clone())
        });
        // Find data is already cached by DirEntry on Windows; no per-entry stat.
        if metadata.file_attributes() & 0x400 != 0 {
            if let Some(secret) = child_secret {
                inventory.secrets.insert(secret);
            }
            continue;
        }
        if depth == MAX_DEPTH {
            return Err(io::Error::other("project link discovery depth exceeded"));
        }
        // Small directories are already distributed among workers. Large
        // directories queue their files too, retaining 16-way parallel opens.
        if inline_files
            && !metadata.is_dir()
            && !inspect(&child, child_secret.as_deref(), roots, protected, inventory)?
        {
            continue;
        }
        children.push(Entry {
            path: child,
            depth: depth + 1,
            secret: child_secret,
            parent: Some(Arc::clone(&pinned)),
            directory: metadata.is_dir(),
        });
    }
    Ok(children)
}
fn child_secret(path: &Path, parent: Option<&Path>) -> Option<PathBuf> {
    parent.map(Path::to_owned).or_else(|| {
        path.file_name()
            .is_some_and(|name| crate::command_sandbox::secret_name(&name.to_string_lossy()))
            .then(|| path.to_owned())
    })
}
fn inspect(
    path: &Path,
    secret: Option<&Path>,
    roots: &[PathBuf],
    protected: &[WinPath],
    inventory: &mut Inventory,
) -> io::Result<bool> {
    let Some(info) = surviving(open(path))? else {
        return Ok(false);
    };
    if let Some(secret) = secret {
        inventory.secrets.insert(secret.to_owned());
    }
    if info.file_attributes() & u64::from(co::FILE_ATTRIBUTE::REPARSE_POINT.raw()) != 0 {
        return Ok(false);
    }
    if info.file_attributes() & u64::from(co::FILE_ATTRIBUTE::DIRECTORY.raw()) != 0 {
        return Ok(true);
    }
    inventory.opened_files += 1;
    if info.number_of_links() > 1 {
        inventory.insert(
            path.to_owned(),
            file_key(&info)?,
            u32::try_from(info.number_of_links()).map_err(io::Error::other)?,
            inventory::private(path, roots, protected),
        );
    }
    Ok(false)
}
fn open_file(path: &Path, share: co::FILE_SHARE) -> io::Result<fs::File> {
    // The standard Windows open accepts OsStr directly; avoid converting every
    // full pathname to UTF-8 and back. Zero access, OPEN_EXISTING, no contents.
    fs::OpenOptions::new()
        .access_mode(0)
        .share_mode(share.raw())
        .custom_flags((co::FILE_FLAG::OPEN_REPARSE_POINT | co::FILE_FLAG::BACKUP_SEMANTICS).raw())
        .open(path)
}
fn open(path: &Path) -> io::Result<Information> {
    information(&open_file(
        path,
        co::FILE_SHARE::READ | co::FILE_SHARE::WRITE | co::FILE_SHARE::DELETE,
    )?)
}
fn file_key(info: &Information) -> io::Result<inventory::FileKey> {
    Ok((
        u32::try_from(info.volume_serial_number()).map_err(io::Error::other)?,
        info.file_index(),
    ))
}
pub(super) fn root_identity(path: &Path) -> io::Result<inventory::FileKey> {
    directory_key(&open(path)?)
}
fn directory_key(info: &Information) -> io::Result<inventory::FileKey> {
    if info.file_attributes() & u64::from(co::FILE_ATTRIBUTE::REPARSE_POINT.raw()) != 0
        || info.file_attributes() & u64::from(co::FILE_ATTRIBUTE::DIRECTORY.raw()) == 0
    {
        return Err(io::Error::other("ledger directory changed"));
    }
    file_key(info)
}
pub(super) fn pin_root(path: &Path) -> io::Result<Arc<Pin>> {
    pin(path, None)
}
pub(super) fn surviving<T>(result: io::Result<T>) -> io::Result<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error)
            if error.kind() == io::ErrorKind::NotFound
                || matches!(error.raw_os_error(), Some(303)) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

// Keep every ancestor pinned until all queued descendant opens finish. A
// pathname must not become a junction between the no-follow check and read_dir.
fn pin(path: &Path, parent: Option<Arc<Pin>>) -> io::Result<Arc<Pin>> {
    let handle = open_file(path, co::FILE_SHARE::READ)?;
    let info = information(&handle)?;
    let key = directory_key(&info)?;
    Ok(Arc::new(Pin {
        _handle: handle,
        _parent: parent,
        key,
    }))
}
fn entries(paths: &[PathBuf], roots: &[PathBuf]) -> io::Result<VecDeque<Entry>> {
    let mut pins = HashMap::<OsString, (Arc<Pin>, usize, Option<PathBuf>)>::new();
    let mut entries = VecDeque::new();
    for path in paths {
        if let Some((parent, depth, secret)) = path.parent().and_then(|p| pins.get(p.as_os_str())) {
            entries.push_back(Entry {
                path: path.clone(),
                depth: depth + 1,
                secret: child_secret(path, secret.as_deref()),
                parent: Some(Arc::clone(parent)),
                directory: false,
            });
            continue;
        }
        let root = roots
            .iter()
            .find(|r| path.starts_with(r))
            .ok_or_else(|| io::Error::other("ledger name outside roots"))?;
        let mut parent = None;
        let ancestors: Vec<_> = path
            .ancestors()
            .skip(1)
            .take_while(|p| p.starts_with(root))
            .collect();
        if ancestors.len() > MAX_DEPTH {
            return Err(io::Error::other("project link discovery depth exceeded"));
        }
        let depth = ancestors.len();
        for (depth, ancestor) in ancestors.into_iter().rev().enumerate() {
            if let Some((existing, _, _)) = pins.get(ancestor.as_os_str()) {
                parent = Some(Arc::clone(existing));
            } else {
                let Some(pinned) = surviving(pin(ancestor, parent.clone()))? else {
                    return Err(io::Error::other("ledger ancestor disappeared"));
                };
                pins.insert(
                    ancestor.as_os_str().to_owned(),
                    (
                        Arc::clone(&pinned),
                        depth,
                        inventory::secret(ancestor, roots),
                    ),
                );
                parent = Some(pinned);
            }
        }
        entries.push_back(Entry {
            path: path.clone(),
            depth,
            secret: inventory::secret(path, roots),
            parent,
            directory: false,
        });
    }
    Ok(entries)
}
