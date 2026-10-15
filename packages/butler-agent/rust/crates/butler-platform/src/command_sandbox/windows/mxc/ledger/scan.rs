//! Parallel no-follow, zero-access identity walk. No entry-count truncation.
use super::inventory::{self, Inventory};
use crate::command_sandbox::{mxc_policy::WinPath, project_secrets::portable::tree::MAX_DEPTH};
use std::{
    collections::{HashMap, VecDeque},
    ffi::OsString,
    fs, io,
    os::windows::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex},
    thread,
};
use winsafe::{HFILE, co};
const THREADS: usize = 16;
struct Pin {
    _handle: Mutex<winsafe::guard::CloseHandleGuard<HFILE>>,
    _parent: Option<Arc<Pin>>,
}
struct Entry {
    path: PathBuf,
    depth: usize,
    secret: Option<PathBuf>,
    parent: Option<Arc<Pin>>,
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
        let count = state.entries.len().min(32);
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
    } = entry;
    if depth > MAX_DEPTH {
        return Err(io::Error::other("project link discovery depth exceeded"));
    }
    if !inspect(&path, secret.as_deref(), roots, protected, inventory)? {
        return Ok(Vec::new());
    }
    let pinned = pin(&path, parent)?;
    let Some(entries) = surviving(fs::read_dir(&path))? else {
        return Ok(Vec::new());
    };
    let entries: Vec<_> = entries.collect();
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
        let child_secret = child_secret(&child, secret.as_deref());
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
    if info.dwFileAttributes.has(co::FILE_ATTRIBUTE::REPARSE_POINT) {
        return Ok(false);
    }
    if info.dwFileAttributes.has(co::FILE_ATTRIBUTE::DIRECTORY) {
        return Ok(true);
    }
    #[cfg(feature = "test-support")]
    {
        inventory.opened_files += 1;
    }
    if info.nNumberOfLinks > 1 {
        inventory.insert(
            path.to_owned(),
            (info.dwVolumeSerialNumber, info.nFileIndex()),
            info.nNumberOfLinks,
            inventory::private(path, roots, protected),
        );
    }
    Ok(false)
}
fn open(path: &Path) -> io::Result<winsafe::BY_HANDLE_FILE_INFORMATION> {
    let (handle, _) = HFILE::CreateFile(
        path.to_str()
            .ok_or_else(|| io::Error::other("non_unicode_path"))?,
        co::GENERIC::default(),
        Some(co::FILE_SHARE::READ | co::FILE_SHARE::WRITE | co::FILE_SHARE::DELETE),
        None,
        co::DISPOSITION::OPEN_EXISTING,
        co::FILE_ATTRIBUTE::NORMAL,
        Some(co::FILE_FLAG::OPEN_REPARSE_POINT | co::FILE_FLAG::BACKUP_SEMANTICS),
        None,
        None,
    )
    .map_err(native_error)?;
    handle.GetFileInformationByHandle().map_err(native_error)
}
fn native_error(error: co::ERROR) -> io::Error {
    io::Error::from_raw_os_error(error.raw().cast_signed())
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
    let (handle, _) = HFILE::CreateFile(
        path.to_str()
            .ok_or_else(|| io::Error::other("non_unicode_path"))?,
        co::GENERIC::default(),
        Some(co::FILE_SHARE::READ),
        None,
        co::DISPOSITION::OPEN_EXISTING,
        co::FILE_ATTRIBUTE::NORMAL,
        Some(co::FILE_FLAG::OPEN_REPARSE_POINT | co::FILE_FLAG::BACKUP_SEMANTICS),
        None,
        None,
    )
    .map_err(native_error)?;
    let info = handle.GetFileInformationByHandle().map_err(native_error)?;
    if info.dwFileAttributes.has(co::FILE_ATTRIBUTE::REPARSE_POINT)
        || !info.dwFileAttributes.has(co::FILE_ATTRIBUTE::DIRECTORY)
    {
        return Err(io::Error::other("ledger directory changed"));
    }
    Ok(Arc::new(Pin {
        _handle: Mutex::new(handle),
        _parent: parent,
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
        });
    }
    Ok(entries)
}
