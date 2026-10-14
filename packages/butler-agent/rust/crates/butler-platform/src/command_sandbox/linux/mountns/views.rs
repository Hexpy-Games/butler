//! Resolve every visible mount view of a protected filesystem coordinate.
use super::super::Error;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

struct Mount {
    device: String,
    source: PathBuf,
    target: PathBuf,
    options: String,
}

pub(super) struct Snapshot(Vec<Mount>);

pub(super) fn snapshot() -> Result<Snapshot, Error> {
    let mut mounts = Vec::new();
    for line in std::fs::read_to_string("/proc/self/mountinfo")?.lines() {
        let fields: Vec<_> = line.split_whitespace().collect();
        let [_, _, device, source, target, options, ..] = fields.as_slice() else {
            return Err("invalid mountinfo".into());
        };
        mounts.push(Mount {
            device: (*device).to_owned(),
            source: decode(source)?,
            target: decode(target)?,
            options: (*options).to_owned(),
        });
    }
    Ok(Snapshot(mounts))
}

impl Snapshot {
    fn backing(&self, path: &Path) -> Result<(&str, PathBuf), Error> {
        // The deepest (and, among stacked mounts, last) prefix is visible.
        let (owner, relative) = self
            .0
            .iter()
            .filter_map(|mount| Some((mount, beneath(path, &mount.target)?)))
            .max_by_key(|(mount, _)| mount.target.as_os_str().len())
            .ok_or("project mount is unknown")?;
        Ok((&owner.device, join(&owner.source, relative)))
    }

    pub(super) fn aliases(&self, paths: &[PathBuf]) -> Result<Vec<PathBuf>, Error> {
        self.withheld(paths, None)
    }

    /// Like [`Self::aliases`], but an alias in another mount is replaced by
    /// that mount's whole target when it overlaps no `keep` root: one denial
    /// (or mask) per view, instead of walking the view's tree once per path.
    pub(super) fn withheld(
        &self,
        paths: &[PathBuf],
        keep: Option<&[PathBuf]>,
    ) -> Result<Vec<PathBuf>, Error> {
        let mut result = BTreeSet::new();
        for original in paths {
            for alias in self.views_of(original)? {
                result.insert(keep.map_or(alias.clone(), |keep| {
                    self.coarse(&alias, Some(original), keep)
                }));
            }
        }
        Ok(result.into_iter().collect())
    }

    /// The target of the mount showing `alias`, when that whole mount can be
    /// withheld: not the root mount, not the original's own mount, and
    /// disjoint from every root that must stay reachable.
    pub(super) fn coarse(
        &self,
        alias: &Path,
        original: Option<&Path>,
        keep: &[PathBuf],
    ) -> PathBuf {
        let owner = self
            .0
            .iter()
            .filter(|mount| beneath(alias, &mount.target).is_some())
            .max_by_key(|mount| mount.target.as_os_str().len())
            .map(|mount| mount.target.as_path());
        match owner {
            Some(target)
                if target != Path::new("/")
                    && original.is_none_or(|original| beneath(original, target).is_none())
                    && keep.iter().all(|root| {
                        beneath(root, target).is_none() && beneath(target, root).is_none()
                    }) =>
            {
                target.to_path_buf()
            }
            _ => alias.to_path_buf(),
        }
    }

    /// `original` and every other visible path of the same object.
    fn views_of(&self, original: &Path) -> Result<Vec<PathBuf>, Error> {
        let mut result = vec![original.to_path_buf()];
        let path: PathBuf = original.components().collect();
        let (device, coordinate) = self.backing(&path)?;
        for mount in self.0.iter().filter(|mount| mount.device == device) {
            let Some(relative) = beneath(&coordinate, &mount.source) else {
                continue;
            };
            let alias = join(&mount.target, relative);
            // A deeper mount can hide this view; retain only aliases whose
            // currently visible backing coordinate is the same object.
            let (visible_device, visible_coordinate) = self.backing(&alias)?;
            if visible_device == device && visible_coordinate == coordinate && alias != path {
                result.push(alias);
            }
        }
        Ok(result)
    }

    /// Each mount target's device number (the topmost of stacked mounts).
    pub(super) fn devices(&self) -> std::collections::HashMap<PathBuf, u64> {
        self.0
            .iter()
            .filter_map(|mount| {
                let (major, minor) = mount.device.split_once(':')?;
                let device = rustix::fs::makedev(major.parse().ok()?, minor.parse().ok()?);
                Some((mount.target.clone(), device))
            })
            .collect()
    }

    /// Each mount's target and per-mount options, in mount order.
    pub(super) fn options(&self) -> impl Iterator<Item = (&Path, &str)> {
        self.0
            .iter()
            .map(|mount| (mount.target.as_path(), mount.options.as_str()))
    }

    pub(super) fn writable_views(&self, roots: &[PathBuf]) -> Result<Vec<PathBuf>, Error> {
        let mut views: BTreeSet<_> = self.aliases(roots)?.into_iter().collect();
        for root in roots {
            let (device, coordinate) = self.backing(root)?;
            for mount in self.0.iter().filter(|mount| mount.device == device) {
                let (visible_device, visible_coordinate) = self.backing(&mount.target)?;
                if mount.source.starts_with(&coordinate)
                    && mount.target.is_dir()
                    && visible_device == device
                    && visible_coordinate == mount.source
                {
                    views.insert(mount.target.clone());
                }
            }
        }
        Ok(views.into_iter().collect())
    }
}

/// `path` relative to `prefix`, comparing bytes of normalized absolute
/// paths: per mount, component iteration dominated setup time.
fn beneath<'a>(path: &'a Path, prefix: &Path) -> Option<&'a Path> {
    use std::os::unix::ffi::OsStrExt;
    let (bytes, prefix) = (path.as_os_str().as_bytes(), prefix.as_os_str().as_bytes());
    let rest = bytes.strip_prefix(prefix)?;
    let rest = if prefix.ends_with(b"/") || rest.is_empty() {
        rest
    } else {
        rest.strip_prefix(b"/")?
    };
    Some(Path::new(std::ffi::OsStr::from_bytes(rest)))
}

fn join(base: &Path, relative: &Path) -> PathBuf {
    if relative.as_os_str().is_empty() {
        base.to_path_buf()
    } else {
        base.join(relative)
    }
}

fn decode(encoded: &str) -> Result<PathBuf, Error> {
    use std::os::unix::ffi::OsStringExt;
    let mut decoded = Vec::new();
    let mut bytes = encoded.as_bytes().iter().copied();
    while let Some(byte) = bytes.next() {
        if byte == b'\\' {
            let mut value = 0u8;
            for digit in [bytes.next(), bytes.next(), bytes.next()] {
                let digit = digit
                    .filter(|digit| (b'0'..=b'7').contains(digit))
                    .ok_or("invalid mountinfo escape")?;
                value = value
                    .checked_mul(8)
                    .and_then(|value| value.checked_add(digit - b'0'))
                    .ok_or("mountinfo escape overflow")?;
            }
            decoded.push(value);
        } else {
            decoded.push(byte);
        }
    }
    Ok(std::ffi::OsString::from_vec(decoded).into())
}
