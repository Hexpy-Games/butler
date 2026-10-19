//! Bounded traversal over no-follow directory adapters.
use super::native;
use std::{
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
    fn root(path: &Path) -> io::Result<Self::Directory>;
    fn child(parent: &Self::Directory, name: &OsStr) -> io::Result<Self::Directory>;
    fn entries(dir: &Self::Directory, collect_links: bool) -> io::Result<Vec<Entry>>;
}
struct Native;
impl Walker for Native {
    type Directory = native::Directory;
    fn root(path: &Path) -> io::Result<Self::Directory> {
        native::open_root(path)
    }
    fn child(parent: &Self::Directory, name: &OsStr) -> io::Result<Self::Directory> {
        native::open_child(parent, name)
    }
    fn entries(dir: &Self::Directory, collect_links: bool) -> io::Result<Vec<Entry>> {
        #[cfg(unix)]
        return native::entries_with_links(dir, collect_links);
        #[cfg(windows)]
        {
            let _ = collect_links;
            Ok(native::entries(dir)?
                .into_iter()
                .map(|(name, directory)| (name, directory, None))
                .collect())
        }
    }
}

pub(in crate::command_sandbox) fn walk(root: &Path, bounded: bool) -> io::Result<Vec<PathBuf>> {
    Ok(scan(root, bounded, false)?.found)
}

#[cfg(unix)]
pub(super) fn walk_for_sweep(root: &Path) -> io::Result<Inventory> {
    let walk = scan(root, false, true)?;
    Ok((walk.found, walk.links))
}

fn scan(root: &Path, bounded: bool, collect_links: bool) -> io::Result<Walk> {
    let dir = Native::root(root)?;
    let mut walk = Walk {
        bounded,
        collect_links,
        visited: 0,
        found: Vec::new(),
        links: Vec::new(),
    };
    walk.visit::<Native>(&dir, Path::new(""), 0)?;
    walk.found.sort();
    Ok(walk)
}
struct Walk {
    bounded: bool,
    collect_links: bool,
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
    ) -> io::Result<()> {
        for (name, directory, link) in W::entries(dir, self.collect_links)? {
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
            if crate::command_sandbox::secret_name(&name.to_string_lossy()) {
                self.found.push(path);
                continue;
            }
            if !directory {
                continue;
            }
            let child = if depth >= MAX_DEPTH {
                Err(io::Error::other("project secret discovery depth exceeded"))
            } else {
                W::child(dir, &name)
            };
            let result = child.and_then(|child| self.visit::<W>(&child, &path, depth + 1));
            match result {
                Ok(()) => {}
                Err(error) if self.bounded => return Err(error),
                Err(_) => self.found.push(path),
            }
        }
        Ok(())
    }
}
