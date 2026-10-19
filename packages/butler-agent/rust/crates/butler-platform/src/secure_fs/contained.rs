//! Fd-relative traversal. Link text is interpreted against a stack of open
//! parents, never against a mutable absolute path.
use crate::{
    secure_fs,
    secure_fs::inventory::{SecretInventory, denied},
};
use rustix::fs::{Mode, OFlags, open, openat, readlinkat};
use std::{
    collections::VecDeque,
    ffi::{OsStr, OsString},
    fs::File,
    io,
    os::unix::{ffi::OsStrExt, fs::MetadataExt},
    path::{Component, Path, PathBuf},
};

pub(super) fn directory(root: &Path) -> io::Result<File> {
    Ok(File::from(open(
        root,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )?))
}

pub(super) fn open_file(
    root: &Path,
    relative: &Path,
    inventory: &SecretInventory,
) -> io::Result<File> {
    let first = directory(root)?;
    let metadata = first.metadata()?;
    inventory.verify_root(root, &first, &metadata)?;
    let mut walk = Walk {
        root,
        inventory,
        mount: mount_id(&first).transpose()?,
        device: secure_fs::identity(&metadata).id.ok_or_else(denied)?.device,
        parents: vec![first],
        names: PathBuf::new(),
        pending: components(relative)?,
    };
    for _ in 0..40 {
        let component = walk.pending.pop_front().ok_or_else(denied)?;
        if let Some(file) = walk.step(&component)? {
            return Ok(file);
        }
    }
    Err(denied())
}

struct Walk<'a> {
    root: &'a Path,
    inventory: &'a SecretInventory,
    mount: Option<u64>,
    device: u64,
    parents: Vec<File>,
    names: PathBuf,
    pending: VecDeque<OsString>,
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
        if secure_fs::secret_name(&component.to_string_lossy())
            || self
                .inventory
                .protects_path(&self.root.join(&self.names).join(component))
        {
            return Err(denied());
        }
        let parent = self.parents.last().ok_or_else(denied)?;
        let file = match open_component(parent, component)? {
            Opened::File(file) => file,
            Opened::Link(text) => {
                let mut target = components(&text)?;
                target.append(&mut self.pending);
                self.pending = target;
                return Ok(None);
            }
        };
        let metadata = file.metadata()?;
        if mount_id(&file).transpose()? != self.mount
            || self.inventory.protects_metadata(&metadata)
            || secure_fs::identity(&metadata)
                .id
                .is_none_or(|id| id.device != self.device)
        {
            return Err(denied());
        }
        if self.pending.is_empty() {
            if !metadata.is_file()
                || (metadata.nlink() > 1 && !self.inventory.permits_hard_link(&metadata))
            {
                return Err(denied());
            }
            return Ok(Some(file));
        }
        if !metadata.is_dir() {
            return Err(denied());
        }
        self.parents.push(file);
        self.names.push(component);
        Ok(None)
    }
}
enum Opened {
    File(File),
    Link(PathBuf),
}
fn open_component(parent: &File, name: &OsStr) -> io::Result<Opened> {
    let flags = OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK;
    match openat(parent, name, flags, Mode::empty()) {
        Ok(fd) => Ok(Opened::File(File::from(fd))),
        Err(error) => {
            let text = readlinkat(parent, name, Vec::new()).map_err(|_| io::Error::from(error))?;
            Ok(Opened::Link(PathBuf::from(OsStr::from_bytes(
                text.to_bytes(),
            ))))
        }
    }
}
fn components(path: &Path) -> io::Result<VecDeque<OsString>> {
    if path.as_os_str().is_empty() || path.is_absolute() {
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
fn mount_id(file: &File) -> Option<io::Result<u64>> {
    use rustix::fs::{AtFlags, StatxFlags, statx};
    Some(
        statx(file, "", AtFlags::EMPTY_PATH, StatxFlags::MNT_ID)
            .map_err(io::Error::from)
            .and_then(|stat| {
                if stat.stx_mask & StatxFlags::MNT_ID.bits() == 0 {
                    return Err(denied());
                }
                Ok(stat.stx_mnt_id)
            }),
    )
}
#[cfg(not(target_os = "linux"))]
fn mount_id(_: &File) -> Option<io::Result<u64>> {
    None
}
