//! M+: every mount outside the writable roots becomes read-only in the
//! private namespace. Landlock does not mediate chmod, chown, utimes or xattr
//! calls; on a read-only mount the VFS refuses them (EROFS), so seccomp may
//! allow them. Success is verified on every reachable mount, never assumed.
use super::super::{Error, Policy};
use nix::mount::{MsFlags, mount};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

fn roots(policy: &Policy) -> Vec<PathBuf> {
    let mut roots = policy.writable.clone();
    roots.extend(policy.project.iter().cloned());
    outermost(&roots)
}

/// Mounts to make read-only, listed before any mask exists: the mount table
/// then holds only the host's entries, not thousands of masks.
pub(in super::super) struct Sealing(BTreeMap<PathBuf, String>);

/// A self-bind detaches each writable root's writability from the parent
/// mount that [`Sealing::seal`] makes read-only. Runs before any mask.
pub(super) fn prepare(policy: &Policy) -> Result<Sealing, Error> {
    let roots = roots(policy);
    bind(&roots)?;
    outside(&roots)
}

/// The probe's throwaway namespace runs the same sequence once per boot.
pub(super) fn probe(root: &Path) -> Result<(), Error> {
    let roots = [root.to_path_buf()];
    bind(&roots)?;
    outside(&roots)?.seal(&[])
}

fn bind(roots: &[PathBuf]) -> Result<(), Error> {
    // Recursive: keep any mounts that already exist below a root.
    for root in roots {
        mount(
            Some(root.as_path()),
            root,
            None::<&str>,
            MsFlags::MS_BIND | MsFlags::MS_REC,
            None::<&str>,
        )?;
    }
    Ok(())
}

fn outside(roots: &[PathBuf]) -> Result<Sealing, Error> {
    // A path reaches only the topmost of stacked mounts: remount with the
    // options of the last entry per target. Lower entries are unreachable.
    let mut outside = BTreeMap::new();
    for (target, options) in super::views::snapshot()?.options() {
        if !roots.iter().any(|root| target.starts_with(root)) {
            outside.insert(target.to_path_buf(), options.to_owned());
        }
    }
    Ok(Sealing(outside))
}

impl Sealing {
    /// Any failure leaves M with metadata calls denied (the caller keeps
    /// the full seccomp filter). Masks mounted since inherit their sealed
    /// source's read-only flag; `masks` outside the roots are verified too.
    pub(in super::super) fn seal(&self, masks: &[PathBuf]) -> Result<(), Error> {
        for (target, options) in &self.0 {
            // Errors are not trusted either way: verification below decides.
            let _ = mount(
                None::<&str>,
                target,
                None::<&str>,
                remount_flags(options),
                None::<&str>,
            );
        }
        for target in self.0.keys().chain(masks) {
            if !read_only(target)? {
                return Err("a mount outside the writable roots remains writable".into());
            }
        }
        Ok(())
    }
}

/// Whether the mount reached through `path` is read-only. An unreachable
/// path counts as read-only: no command can reach that mount by name.
pub(super) fn read_only(path: &Path) -> Result<bool, Error> {
    match rustix::fs::statvfs(path) {
        Ok(stat) => Ok(stat.f_flag.contains(rustix::fs::StatVfsMountFlags::RDONLY)),
        Err(rustix::io::Errno::NOENT | rustix::io::Errno::NOTDIR | rustix::io::Errno::ACCESS) => {
            Ok(true)
        }
        Err(error) => Err(error.into()),
    }
}

fn outermost(roots: &[PathBuf]) -> Vec<PathBuf> {
    let sorted: BTreeSet<_> = roots.iter().cloned().collect();
    sorted
        .iter()
        .filter(|root| {
            !sorted
                .iter()
                .any(|other| other != *root && root.starts_with(other))
        })
        .cloned()
        .collect()
}

// A user namespace cannot clear flags its parent locked (nosuid, nodev,
// noexec, atime); repeat them, and nosymfollow, so only read-only is added.
fn remount_flags(options: &str) -> MsFlags {
    options.split(',').fold(
        MsFlags::MS_BIND | MsFlags::MS_REMOUNT | MsFlags::MS_RDONLY,
        |flags, option| {
            flags
                | match option {
                    "nosuid" => MsFlags::MS_NOSUID,
                    "nodev" => MsFlags::MS_NODEV,
                    "noexec" => MsFlags::MS_NOEXEC,
                    "noatime" => MsFlags::MS_NOATIME,
                    "nodiratime" => MsFlags::MS_NODIRATIME,
                    "relatime" => MsFlags::MS_RELATIME,
                    "nosymfollow" => MsFlags::from_bits_retain(nix::libc::MS_NOSYMFOLLOW),
                    _ => MsFlags::empty(),
                }
        },
    )
}
