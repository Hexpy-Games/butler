//! Bounded traversal over no-follow directory adapters.
use super::native;
use std::{
    ffi::{OsStr, OsString},
    io,
    path::{Path, PathBuf},
};
pub(in crate::command_sandbox) const MAX_ENTRIES: usize = 200_000;
pub(in crate::command_sandbox) const MAX_DEPTH: usize = 128;

trait Walker {
    type Directory;
    type Entry;
    fn root(path: &Path) -> io::Result<Self::Directory>;
    fn child(parent: &Self::Directory, name: &OsStr) -> io::Result<Self::Directory>;
    fn entries(dir: &Self::Directory) -> io::Result<Vec<Self::Entry>>;
    fn split(entry: Self::Entry) -> (OsString, bool, bool);
}
struct Native;
impl Walker for Native {
    type Directory = native::Directory;
    type Entry = (OsString, bool);
    fn root(path: &Path) -> io::Result<Self::Directory> {
        native::open_root(path)
    }
    fn child(parent: &Self::Directory, name: &OsStr) -> io::Result<Self::Directory> {
        native::open_child(parent, name)
    }
    fn entries(dir: &Self::Directory) -> io::Result<Vec<Self::Entry>> {
        native::entries(dir)
    }
    fn split((name, directory): Self::Entry) -> (OsString, bool, bool) {
        (name, directory, false)
    }
}
#[cfg(unix)]
struct Capture;
#[cfg(unix)]
impl Walker for Capture {
    type Directory = native::Directory;
    type Entry = (OsString, bool, bool);
    fn root(path: &Path) -> io::Result<Self::Directory> {
        Native::root(path)
    }
    fn child(parent: &Self::Directory, name: &OsStr) -> io::Result<Self::Directory> {
        Native::child(parent, name)
    }
    fn entries(dir: &Self::Directory) -> io::Result<Vec<Self::Entry>> {
        native::entries_with_links(dir)
    }
    fn split(entry: Self::Entry) -> (OsString, bool, bool) {
        entry
    }
}

pub(in crate::command_sandbox) fn walk(root: &Path, bounded: bool) -> io::Result<Vec<PathBuf>> {
    Ok(scan::<Native>(root, bounded)?.found)
}
#[cfg(unix)]
pub(in crate::command_sandbox) fn entries(
    root: &Path,
    bounded: bool,
) -> io::Result<(Vec<PathBuf>, Vec<PathBuf>)> {
    let walk = scan::<Capture>(root, bounded)?;
    Ok((walk.found, walk.links))
}
fn scan<W: Walker>(root: &Path, bounded: bool) -> io::Result<Walk> {
    let dir = W::root(root)?;
    let mut walk = Walk {
        bounded,
        visited: 0,
        found: Vec::new(),
        links: Vec::new(),
    };
    walk.visit::<W>(&dir, Path::new(""), 0)?;
    walk.found.sort();
    Ok(walk)
}
struct Walk {
    bounded: bool,
    visited: usize,
    found: Vec<PathBuf>,
    links: Vec<PathBuf>,
}
impl Walk {
    fn visit<W: Walker>(
        &mut self,
        dir: &W::Directory,
        relative: &Path,
        depth: usize,
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
            if link {
                self.links.push(path.clone());
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
