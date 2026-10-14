//! A pathname boundary cannot isolate an inode shared with an unknown alias.
use super::super::project_secrets::portable::{
    tree::{MAX_DEPTH, MAX_ENTRIES},
    unix as tree,
};
use super::Error;
use rustix::fs::{AtFlags, FileType, statat};
use std::collections::{HashMap, HashSet};
use std::os::fd::OwnedFd;
use std::path::{Path, PathBuf};

#[derive(Default)]
struct Group {
    seen: u128,
    expected: u128,
    private: bool,
    public: bool,
}

pub(super) fn validate(policy: &super::Policy) -> Result<(), Error> {
    let root = policy.project.as_deref().ok_or("missing project")?;
    let strict: HashSet<_> = policy
        .credentials
        .iter()
        .chain(&policy.secrets)
        .cloned()
        .collect();
    let mut protected = strict.clone();
    protected.extend(policy.write_denied.iter().cloned());
    let mut walk = Walk {
        protected,
        groups: HashMap::new(),
        directories: HashSet::new(),
        visited: 0,
    };
    for path in std::iter::once(root).chain(policy.writable.iter().map(PathBuf::as_path)) {
        // Inside the walk only the entry itself can be protected: protected
        // directories are not entered. Ancestors above the root count once;
        // a scratch root below a denied data folder is an explicit exception.
        let inherited = path.ancestors().any(|ancestor| {
            if path == root {
                walk.protected.contains(ancestor)
            } else {
                strict.contains(ancestor)
            }
        });
        walk.visit(&tree::open_root(path)?, path, 0, inherited)?;
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

struct Walk {
    protected: HashSet<PathBuf>,
    groups: HashMap<(u64, u64), Group>,
    directories: HashSet<(u64, u64)>,
    visited: usize,
}

impl Walk {
    fn visit(
        &mut self,
        dir: &OwnedFd,
        path: &Path,
        depth: usize,
        inherited: bool,
    ) -> Result<(), Error> {
        let stat = rustix::fs::fstat(dir)?;
        if !self.directories.insert((stat.st_dev, stat.st_ino)) {
            return Ok(());
        }
        for (name, directory) in tree::entries(dir)? {
            self.visited += 1;
            if self.visited > MAX_ENTRIES {
                return Err("project link discovery entry limit exceeded".into());
            }
            let child = path.join(&name);
            let private = inherited
                || crate::command_sandbox::secret_name(&name.to_string_lossy())
                || self.protected.contains(&child);
            if directory {
                if private {
                    continue;
                }
                if depth >= MAX_DEPTH {
                    return Err("project link discovery depth exceeded".into());
                }
                self.visit(&tree::open_child(dir, &name)?, &child, depth + 1, false)?;
            } else {
                let stat = statat(dir, name.as_os_str(), AtFlags::SYMLINK_NOFOLLOW)?;
                if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile
                    || stat.st_nlink <= 1
                {
                    continue;
                }
                let group = self.groups.entry((stat.st_dev, stat.st_ino)).or_default();
                let links = u128::from(stat.st_nlink);
                if group.seen > 0 && group.expected != links {
                    return Err("project link inventory changed".into());
                }
                group.seen += 1;
                group.expected = links;
                group.private |= private;
                group.public |= !private;
            }
        }
        Ok(())
    }
}
