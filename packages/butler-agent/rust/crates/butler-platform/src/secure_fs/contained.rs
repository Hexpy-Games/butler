//! Fd-relative traversal. Cached directories belong to one read request, never
//! a process: a later command cannot reuse an earlier command's path decisions.
use crate::{
    secure_fs,
    secure_fs::inventory::{SecretInventory, denied, sensitive},
};
use rustix::fs::{AtFlags, FileType, Mode, OFlags, open, openat, readlinkat, statat};
use std::{
    collections::{HashMap, VecDeque},
    ffi::{OsStr, OsString},
    fs::File,
    io,
    os::unix::{ffi::OsStrExt, fs::MetadataExt},
    path::{Component, Path, PathBuf},
    sync::Arc,
};

#[cfg(target_os = "linux")]
fn directory_flags() -> OFlags {
    OFlags::PATH
}
// macOS retains O_RDONLY traversal: intermediate directories require read
// permission as well as search permission. The request fd cache is portable.
#[cfg(not(target_os = "linux"))]
fn directory_flags() -> OFlags {
    OFlags::RDONLY
}

pub(super) fn directory(root: &Path) -> io::Result<File> {
    Ok(File::from(open(
        root,
        directory_flags() | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )?))
}

#[derive(Default)]
pub(super) struct Cache {
    roots: HashMap<PathBuf, Root>,
}
struct Root {
    canonical: PathBuf,
    revision: u64,
    mount: Option<u64>,
    device: u64,
    directories: HashMap<PathBuf, Arc<File>>,
    protected: Vec<PathBuf>,
    protected_ids: Vec<secure_fs::FileId>,
}
impl Root {
    fn new(root: &Path, inventory: &SecretInventory, extra: &[PathBuf]) -> io::Result<Self> {
        let mut resolved = inventory.resolved_paths();
        let canonical = inventory.canonical_root(root)?;
        let first = directory(&canonical)?;
        let metadata = first.metadata()?;
        inventory.verify_root(&canonical, &first, &metadata)?;
        resolved.extend(
            extra
                .iter()
                .filter_map(|path| super::canonicalize(path).ok()),
        );
        let protected_ids = extra
            .iter()
            .filter_map(|path| {
                std::fs::metadata(path)
                    .ok()
                    .and_then(|metadata| secure_fs::identity(&metadata).id)
            })
            .collect();
        let protected = inventory
            .paths()
            .iter()
            .chain(resolved.iter())
            .chain(extra.iter())
            .filter_map(|path| path.strip_prefix(&canonical).ok().map(Path::to_path_buf))
            .collect();
        if extra
            .iter()
            .chain(resolved.iter())
            .any(|path| canonical.starts_with(path))
        {
            return Err(denied());
        }
        Ok(Self {
            revision: inventory.revision(),
            canonical,
            mount: mount_id(&first)?,
            device: metadata.dev(),
            directories: HashMap::from([(PathBuf::new(), Arc::new(first))]),
            protected,
            protected_ids,
        })
    }
}

impl Cache {
    pub(super) fn open(
        &mut self,
        root: &Path,
        relative: &Path,
        inventory: &SecretInventory,
        extra: &[PathBuf],
    ) -> io::Result<File> {
        if self
            .roots
            .get(root)
            .is_none_or(|cached| cached.revision != inventory.revision())
        {
            self.roots
                .insert(root.to_path_buf(), Root::new(root, inventory, extra)?);
        }
        let root = self.roots.get_mut(root).ok_or_else(denied)?;
        if root.canonical.as_os_str().len() + relative.as_os_str().len() > path_max() {
            return Err(denied());
        }
        let mut walk = Walk {
            inventory,
            parents: vec![
                root.directories
                    .get(Path::new(""))
                    .ok_or_else(denied)?
                    .clone(),
            ],
            root,
            names: PathBuf::new(),
            pending: components(relative)?,
            links: 0,
        };
        while let Some(component) = walk.pending.pop_front() {
            if let Some(file) = walk.step(&component)? {
                return Ok(file);
            }
        }
        Err(io::Error::new(io::ErrorKind::InvalidInput, "not_a_file"))
    }
}
struct Walk<'a> {
    root: &'a mut Root,
    inventory: &'a SecretInventory,
    parents: Vec<Arc<File>>,
    names: PathBuf,
    pending: VecDeque<OsString>,
    links: usize,
}
impl Walk<'_> {
    fn step(&mut self, component: &OsStr) -> io::Result<Option<File>> {
        if component == ".." {
            if self.parents.len() <= 1 {
                return Err(denied());
            }
            self.parents.pop();
            self.names.pop();
            return Ok(None);
        }
        if component == "." {
            return Ok(None);
        }
        self.names.push(component);
        self.check_name(component)?;
        let intermediate = !self.pending.is_empty();
        if intermediate && let Some(file) = self.root.directories.get(&self.names) {
            self.parents.push(file.clone());
            return Ok(None);
        }
        let parent = self.parents.last().ok_or_else(denied)?;
        let file = match open_component(parent, component, intermediate)? {
            Opened::File(file) => file,
            Opened::Link(text) => {
                self.names.pop();
                self.expand(&text)?;
                return Ok(None);
            }
        };
        let metadata = file.metadata()?;
        if self.inventory.protects_metadata(&metadata) {
            return Err(sensitive());
        }
        if metadata.dev() != self.root.device
            || secure_fs::identity(&metadata)
                .id
                .is_some_and(|id| self.root.protected_ids.contains(&id))
            || matches!((self.root.mount, mount_id(&file)?), (Some(root), Some(child)) if root != child)
        {
            return Err(denied());
        }
        if !intermediate {
            if !metadata.is_file() {
                return Err(io::Error::new(io::ErrorKind::InvalidInput, "not_a_file"));
            }
            if metadata.nlink() > 1 && !self.inventory.permits_hard_link(&metadata) {
                return Err(sensitive());
            }
            return Ok(Some(file));
        }
        if !metadata.is_dir() {
            return Err(io::Error::new(io::ErrorKind::NotADirectory, "not_a_file"));
        }
        let file = Arc::new(file);
        // Keep the request's descriptor budget bounded without rejecting deep
        // walks or large trees. Eviction changes cost, never admission/content.
        if self.root.directories.len() < 256 {
            self.root
                .directories
                .insert(self.names.clone(), file.clone());
        }
        self.parents.push(file);
        Ok(None)
    }

    fn check_name(&self, component: &OsStr) -> io::Result<()> {
        if secure_fs::secret_name(&component.to_string_lossy()) {
            return Err(sensitive());
        }
        if self
            .root
            .protected
            .iter()
            .any(|root| self.names.starts_with(root))
        {
            return Err(
                if self
                    .inventory
                    .protects_path(&self.root.canonical.join(&self.names))
                {
                    sensitive()
                } else {
                    denied()
                },
            );
        }
        Ok(())
    }

    fn expand(&mut self, text: &Path) -> io::Result<()> {
        self.links += 1;
        if self.links > 40 {
            return Err(denied());
        }
        let text = if text.is_absolute() {
            let text = text
                .strip_prefix(&self.root.canonical)
                .map_err(|_| denied())?;
            self.parents.truncate(1);
            self.names.clear();
            text
        } else {
            text
        };
        let mut target = if text.as_os_str().is_empty() {
            VecDeque::new()
        } else {
            components(text)?
        };
        target.append(&mut self.pending);
        let bytes = self.root.canonical.as_os_str().len()
            + self.names.as_os_str().len()
            + target.iter().map(|part| part.len() + 1).sum::<usize>();
        if bytes > path_max() {
            return Err(denied());
        }
        self.pending = target;
        Ok(())
    }
}
enum Opened {
    File(File),
    Link(PathBuf),
}
fn open_component(parent: &File, name: &OsStr, intermediate: bool) -> io::Result<Opened> {
    let access = if intermediate {
        directory_flags() | OFlags::DIRECTORY
    } else {
        OFlags::RDONLY
    };
    let flags = access | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK;
    match openat(parent, name, flags, Mode::empty()) {
        Ok(fd) => Ok(Opened::File(File::from(fd))),
        Err(error) => {
            let text = readlinkat(parent, name, Vec::new()).map_err(|_| {
                if statat(parent, name, AtFlags::SYMLINK_NOFOLLOW).is_ok_and(|stat| {
                    !matches!(
                        FileType::from_raw_mode(stat.st_mode),
                        FileType::RegularFile | FileType::Symlink
                    )
                }) {
                    io::Error::new(io::ErrorKind::InvalidInput, "not_a_file")
                } else {
                    io::Error::from(error)
                }
            })?;
            Ok(Opened::Link(PathBuf::from(OsStr::from_bytes(
                text.to_bytes(),
            ))))
        }
    }
}
fn path_max() -> usize {
    if cfg!(target_os = "macos") {
        1024
    } else {
        4096
    }
}
fn components(path: &Path) -> io::Result<VecDeque<OsString>> {
    if path.as_os_str().is_empty() || path.is_absolute() || path.as_os_str().len() > path_max() {
        return Err(denied());
    }
    path.components()
        .map(|part| match part {
            Component::Normal(name) => Ok(name.to_os_string()),
            Component::ParentDir => Ok("..".into()),
            Component::CurDir => Ok(".".into()),
            _ => Err(denied()),
        })
        .collect()
}
#[cfg(target_os = "linux")]
fn mount_id(file: &File) -> io::Result<Option<u64>> {
    use rustix::fs::{AtFlags, StatxFlags, statx};
    match statx(file, "", AtFlags::EMPTY_PATH, StatxFlags::MNT_ID) {
        Ok(stat) => Ok((stat.stx_mask & StatxFlags::MNT_ID.bits() != 0).then_some(stat.stx_mnt_id)),
        // Older kernels retain the same no-follow fd walk and st_dev fence.
        Err(rustix::io::Errno::NOSYS | rustix::io::Errno::INVAL | rustix::io::Errno::OPNOTSUPP) => {
            Ok(None)
        }
        Err(error) => Err(error.into()),
    }
}
#[cfg(not(target_os = "linux"))]
fn mount_id(_: &File) -> io::Result<Option<u64>> {
    Ok(None)
}
