//! Bounded traversal over no-follow directory adapters.
use super::native;
use std::{
    collections::HashSet,
    ffi::{OsStr, OsString},
    io,
    path::{Path, PathBuf},
};
pub(in crate::command_sandbox) type LinkTime = std::time::SystemTime;
pub(super) type Entry = (OsString, bool, Option<LinkTime>);
type Links = Vec<(PathBuf, LinkTime)>;
#[cfg(unix)]
type Inventory = (Vec<PathBuf>, Links);
pub(in crate::command_sandbox) const MAX_ENTRIES: usize = 200_000;
pub(in crate::command_sandbox) const MAX_DEPTH: usize = 128;

trait Walker {
    type Directory;
    type Entry;
    const SWEEP: bool;
    fn root(path: &Path) -> io::Result<Self::Directory>;
    fn child(parent: &Self::Directory, name: &OsStr) -> io::Result<Self::Directory>;
    fn entries(dir: &Self::Directory) -> io::Result<Vec<Self::Entry>>;
    fn split(entry: Self::Entry) -> Entry;
}
struct Native;
impl Walker for Native {
    type Directory = native::Directory;
    type Entry = (OsString, bool);
    const SWEEP: bool = false;
    fn root(path: &Path) -> io::Result<Self::Directory> {
        native::open_root(path)
    }
    fn child(parent: &Self::Directory, name: &OsStr) -> io::Result<Self::Directory> {
        native::open_child(parent, name)
    }
    fn entries(dir: &Self::Directory) -> io::Result<Vec<Self::Entry>> {
        native::entries(dir)
    }
    fn split((name, directory): Self::Entry) -> Entry {
        (name, directory, None)
    }
}
#[cfg(unix)]
struct Sweep;
#[cfg(unix)]
impl Walker for Sweep {
    type Directory = native::Directory;
    type Entry = Entry;
    const SWEEP: bool = true;
    fn root(path: &Path) -> io::Result<Self::Directory> {
        native::open_root(path)
    }
    fn child(parent: &Self::Directory, name: &OsStr) -> io::Result<Self::Directory> {
        native::open_child(parent, name)
    }
    fn entries(dir: &Self::Directory) -> io::Result<Vec<Self::Entry>> {
        native::entries_with_links(dir)
    }
    fn split(entry: Self::Entry) -> Entry {
        entry
    }
}

pub(in crate::command_sandbox) fn walk(root: &Path, bounded: bool) -> io::Result<Vec<PathBuf>> {
    Ok(scan::<Native>(root, bounded, None)?.found)
}

#[cfg(unix)]
pub(super) fn walk_for_sweep(root: &Path, existing: &[PathBuf]) -> io::Result<Inventory> {
    let walk = scan::<Sweep>(root, false, Some(existing))?;
    Ok((walk.found, walk.links))
}

fn scan<W: Walker>(root: &Path, bounded: bool, existing: Option<&[PathBuf]>) -> io::Result<Walk> {
    let dir = W::root(root)?;
    let mut walk = Walk {
        bounded,
        existing: existing
            .into_iter()
            .flatten()
            .filter_map(|path| path.strip_prefix(root).ok().map(Path::to_path_buf))
            .collect(),
        visited: 0,
        found: Vec::new(),
        links: Vec::new(),
    };
    walk.visit::<W>(&dir, Path::new(""), 0, false)?;
    walk.found.sort();
    Ok(walk)
}
struct Walk {
    bounded: bool,
    existing: HashSet<PathBuf>,
    visited: usize,
    found: Vec<PathBuf>,
    links: Links,
}
impl Walk {
    fn visit<W: Walker>(
        &mut self,
        dir: &W::Directory,
        relative: &Path,
        depth: usize,
        protected_parent: bool,
    ) -> io::Result<()> {
        for entry in W::entries(dir)? {
            let (name, directory, link) = W::split(entry);
            self.visited += 1;
            if self.bounded && self.visited > MAX_ENTRIES {
                return Err(io::Error::other(
                    "project secret discovery entry limit exceeded",
                ));
            }
            let path = relative.join(&name);
            if let Some(ctime) = link {
                self.links.push((path.clone(), ctime));
            }
            let secret = crate::command_sandbox::secret_name(&name.to_string_lossy());
            if secret && !W::SWEEP {
                self.found.push(path);
                continue;
            }
            if secret && !protected_parent {
                self.found.push(path.clone());
                // New secret directories move whole. Existing ones must still
                // have their links judged: scratch can retarget their contents.
                if !self.existing.contains(&path) {
                    continue;
                }
            }
            if !directory {
                continue;
            }
            let child = if depth >= MAX_DEPTH {
                Err(io::Error::other("project secret discovery depth exceeded"))
            } else {
                W::child(dir, &name)
            };
            let result = child.and_then(|child| {
                self.visit::<W>(
                    &child,
                    &path,
                    depth + 1,
                    W::SWEEP && (protected_parent || secret),
                )
            });
            match result {
                Ok(()) => {}
                Err(error) if self.bounded => return Err(error),
                Err(_) => self.found.push(path),
            }
        }
        Ok(())
    }
}
