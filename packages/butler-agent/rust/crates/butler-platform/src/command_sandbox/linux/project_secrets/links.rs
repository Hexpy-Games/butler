//! A pathname boundary cannot isolate an inode shared with an unknown alias.
use super::super::Error;
use super::tree;
use rustix::fs::{AtFlags, FileType, statat};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::os::fd::OwnedFd;
use std::path::{Path, PathBuf};

#[derive(Default)]
struct Group {
    seen: u128,
    expected: u128,
    private: bool,
    public: bool,
}

pub(super) fn validate(policy: &super::super::Policy) -> Result<(), Error> {
    let root = policy.project.as_deref().ok_or("missing project")?;
    let strict: BTreeSet<_> = policy
        .credentials
        .iter()
        .chain(&policy.secrets)
        .cloned()
        .collect();
    let mut walk = Walk {
        protected: BTreeSet::new(),
        groups: HashMap::new(),
        directories: HashSet::new(),
        visited: 0,
    };
    for path in std::iter::once(root).chain(policy.writable.iter().map(PathBuf::as_path)) {
        walk.protected = strict.clone();
        walk.protected.extend(
            policy
                .write_denied
                .iter()
                .filter(|denied| path == root || !path.starts_with(denied))
                .cloned(),
        );
        walk.visit(&tree::open_root(path)?, path, 0)?;
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
    protected: BTreeSet<PathBuf>,
    groups: HashMap<(u64, u64), Group>,
    directories: HashSet<(u64, u64)>,
    visited: usize,
}

impl Walk {
    fn visit(&mut self, dir: &OwnedFd, path: &Path, depth: usize) -> Result<(), Error> {
        let stat = rustix::fs::fstat(dir)?;
        if !self.directories.insert((stat.st_dev, stat.st_ino)) {
            return Ok(());
        }
        for (name, directory) in tree::entries(dir)? {
            self.visited += 1;
            if self.visited > tree::MAX_ENTRIES {
                return Err("project link discovery entry limit exceeded".into());
            }
            let child = path.join(&name);
            let private = crate::command_sandbox::secret_name(&name.to_string_lossy())
                || child
                    .ancestors()
                    .any(|ancestor| self.protected.contains(ancestor));
            if directory {
                if private {
                    continue;
                }
                if depth >= tree::MAX_DEPTH {
                    return Err("project link discovery depth exceeded".into());
                }
                self.visit(&tree::open_child(dir, &name)?, &child, depth + 1)?;
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
