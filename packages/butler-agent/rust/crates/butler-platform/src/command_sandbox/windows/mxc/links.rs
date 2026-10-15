//! A pathname grant cannot isolate hard links to uninspected/protected entries.
use super::Error;
use crate::command_sandbox::{
    mxc_policy::WinPath,
    project_secrets::portable::tree::{MAX_DEPTH, MAX_ENTRIES},
};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};
use winsafe::{HFILE, co};

#[derive(Default)]
struct Group {
    seen: u32,
    expected: u32,
    private: bool,
    public: bool,
}
struct Walk {
    protected: HashSet<WinPath>,
    groups: HashMap<(u32, u64), Group>,
    visited: usize,
}
pub(super) fn validate(roots: &[PathBuf], protected: &[WinPath]) -> Result<(), Error> {
    let mut walk = Walk {
        protected: protected.iter().cloned().collect(),
        groups: HashMap::new(),
        visited: 0,
    };
    for root in roots {
        walk.visit(&fs::canonicalize(root)?, 0)?;
    }
    if walk
        .groups
        .values()
        .any(|group| group.seen != group.expected || (group.private && group.public))
    {
        return Err(
            "project_write_link_aliases: hard links reach uninspected or protected entries".into(),
        );
    }
    Ok(())
}
impl Walk {
    fn visit(&mut self, root: &Path, depth: usize) -> Result<(), Error> {
        if depth > MAX_DEPTH {
            return Err("project link discovery depth exceeded".into());
        }
        let entries = if depth == 0 {
            fs::read_dir(root)?
        } else {
            let Some(entries) = surviving(fs::read_dir(root))? else {
                return Ok(());
            };
            entries
        };
        for entry in entries {
            let Some(entry) = surviving(entry)? else {
                continue;
            };
            self.visited += 1;
            if self.visited > MAX_ENTRIES {
                return Err("project link discovery entry limit exceeded".into());
            }
            let path = entry.path();
            let Some(kind) = surviving(entry.file_type())? else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            // Native no-follow opens retain the canonical long-path prefix;
            // strip only that OS-produced prefix for portable policy comparison.
            let text = path.to_str().ok_or("non_unicode_path")?;
            let comparable = text.strip_prefix(r"\\?\").unwrap_or(text);
            let private = crate::command_sandbox::secret_name(&entry.file_name().to_string_lossy())
                || self.protected.contains(&WinPath::new(comparable)?);
            if kind.is_dir() {
                // Aliases into skipped protected trees remain unaccounted for,
                // so their public counterpart will fail the count check.
                if !private {
                    self.visit(&path, depth + 1)?;
                }
            } else if kind.is_file() {
                surviving(self.file(&path, private))?;
            }
        }
        Ok(())
    }
    fn file(&mut self, path: &Path, private: bool) -> Result<(), Error> {
        let (handle, _) = HFILE::CreateFile(
            path.to_str().ok_or("non_unicode_path")?,
            co::GENERIC::default(),
            Some(co::FILE_SHARE::READ | co::FILE_SHARE::WRITE | co::FILE_SHARE::DELETE),
            None,
            co::DISPOSITION::OPEN_EXISTING,
            co::FILE_ATTRIBUTE::NORMAL,
            Some(co::FILE_FLAG::OPEN_REPARSE_POINT),
            None,
            None,
        )?;
        let info = handle.GetFileInformationByHandle()?;
        if info.nNumberOfLinks <= 1 {
            return Ok(());
        }
        let group = self
            .groups
            .entry((info.dwVolumeSerialNumber, info.nFileIndex()))
            .or_default();
        if group.seen > 0 && group.expected != info.nNumberOfLinks {
            return Err("project link inventory changed".into());
        }
        group.expected = info.nNumberOfLinks;
        group.seen += 1;
        group.private |= private;
        group.public |= !private;
        Ok(())
    }
}

// A concurrent build or cleanup may unlink an entry after enumeration.
fn surviving<T>(result: Result<T, impl Into<Error>>) -> Result<Option<T>, Error> {
    match result.map_err(Into::into) {
        Ok(value) => Ok(Some(value)),
        Err(error)
            if error.downcast_ref::<std::io::Error>().is_some_and(|e| {
                e.kind() == std::io::ErrorKind::NotFound || e.raw_os_error() == Some(303)
            }) || error.downcast_ref::<co::ERROR>().is_some_and(|e| {
                *e == co::ERROR::FILE_NOT_FOUND
                    || *e == co::ERROR::PATH_NOT_FOUND
                    || *e == co::ERROR::DELETE_PENDING
            }) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}
