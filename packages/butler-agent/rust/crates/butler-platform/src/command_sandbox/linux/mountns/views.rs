//! Resolve every visible mount view of a protected filesystem coordinate.
use super::super::Error;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

struct Mount {
    device: String,
    source: PathBuf,
    target: PathBuf,
}

pub(super) struct Snapshot(Vec<Mount>);

pub(super) fn snapshot() -> Result<Snapshot, Error> {
    let mut mounts = Vec::new();
    for line in std::fs::read_to_string("/proc/self/mountinfo")?.lines() {
        let fields: Vec<_> = line.split_whitespace().collect();
        let [_, _, device, source, target, _, ..] = fields.as_slice() else {
            return Err("invalid mountinfo".into());
        };
        mounts.push(Mount {
            device: (*device).to_owned(),
            source: decode(source)?,
            target: decode(target)?,
        });
    }
    Ok(Snapshot(mounts))
}

impl Snapshot {
    fn backing(&self, path: &Path) -> Result<(&str, PathBuf), Error> {
        let owner = self
            .0
            .iter()
            .filter(|mount| path.starts_with(&mount.target))
            .max_by_key(|mount| mount.target.components().count())
            .ok_or("project mount is unknown")?;
        Ok((
            &owner.device,
            owner.source.join(path.strip_prefix(&owner.target)?),
        ))
    }

    pub(super) fn aliases(&self, paths: &[PathBuf]) -> Result<Vec<PathBuf>, Error> {
        let mut result = BTreeSet::new();
        for path in paths {
            let (device, coordinate) = self.backing(path)?;
            result.insert(path.clone());
            for mount in self.0.iter().filter(|mount| mount.device == device) {
                let Ok(relative) = coordinate.strip_prefix(&mount.source) else {
                    continue;
                };
                let alias = mount.target.join(relative);
                // A deeper mount can hide this view; retain only aliases whose
                // currently visible backing coordinate is the same object.
                let (visible_device, visible_coordinate) = self.backing(&alias)?;
                if visible_device == device && visible_coordinate == coordinate {
                    result.insert(alias);
                }
            }
        }
        Ok(result.into_iter().collect())
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
