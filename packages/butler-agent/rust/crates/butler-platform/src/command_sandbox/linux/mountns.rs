//! Private mount namespace; failures never authorize a broader Landlock grant.
use super::{Error, Policy};
use nix::mount::{MsFlags, mount};
use nix::sched::{CloneFlags, unshare};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
mod cache;
mod harden;
mod views;
pub(super) use harden::Sealing;
#[cfg(feature = "test-support")]
pub use views::verify_mount_plan_contract;

/// M masks existing secrets; M+ also makes every mount outside the writable
/// roots read-only, so metadata calls Landlock cannot mediate become safe.
#[derive(Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(super) enum Tier {
    L,
    M,
    MPlus,
}

pub(super) fn enter() -> Result<(), Error> {
    let uid = nix::unistd::getuid().as_raw();
    let gid = nix::unistd::getgid().as_raw();
    unshare(CloneFlags::CLONE_NEWUSER | CloneFlags::CLONE_NEWNS)?;
    std::fs::write("/proc/self/uid_map", format!("{uid} {uid} 1"))?;
    std::fs::write("/proc/self/setgroups", "deny")?;
    std::fs::write("/proc/self/gid_map", format!("{gid} {gid} 1"))?;
    mount(
        None::<&str>,
        "/",
        None::<&str>,
        MsFlags::MS_REC | MsFlags::MS_PRIVATE,
        None::<&str>,
    )?;
    Ok(())
}

fn bind(source: &Path, target: &Path, flags: MsFlags) -> Result<(), Error> {
    mount(
        Some(source),
        target,
        None::<&str>,
        MsFlags::MS_BIND | flags,
        None::<&str>,
    )?;
    Ok(())
}

pub(super) fn probe_child() -> Result<(), Error> {
    enter()?;
    let root = std::env::temp_dir().join(format!("butler-mount-probe-{}", std::process::id()));
    std::fs::create_dir(&root)?;
    let result = probe_mount(&root);
    let plus = result.is_ok() && harden::probe(&root).is_ok();
    // The namespace disappears on exit; the parent removes the empty directory.
    let _ = nix::mount::umount2(&root, nix::mount::MntFlags::MNT_DETACH);
    let _ = std::fs::remove_dir(&root);
    result.map(|()| println!("{}", if plus { "M+" } else { "M" }))
}

// Exercise the exact mask sequence: read-only scratch sources and binds.
fn probe_mount(root: &Path) -> Result<(), Error> {
    let source = Source::mount(root)?;
    let (file, directory) = (root.join("probe-file"), root.join("probe-directory"));
    std::fs::write(&file, [])?;
    std::fs::create_dir(&directory)?;
    source.seal(root)?;
    source.cover(&file)?;
    source.cover(&directory)?;
    for path in [file, directory] {
        if !harden::read_only(&path)? {
            return Err("mask is writable".into());
        }
    }
    Ok(())
}

pub(super) fn tier() -> Tier {
    #[cfg(feature = "test-support")]
    if std::env::var_os("BUTLER_TEST_SANDBOX_FORCE_L").is_some() {
        return Tier::L;
    }
    static RESULT: std::sync::OnceLock<Tier> = std::sync::OnceLock::new();
    *RESULT.get_or_init(|| super::helper().map_or(Tier::L, |helper| cache::probe(&helper)))
}

pub(super) fn available() -> bool {
    !matches!(tier(), Tier::L)
}

pub(super) fn remember(data: &Path) {
    cache::remember(data);
}

/// Closes denials over other mount views. Another view of a writable root
/// is denied (and on Tier M hidden) as a whole, so entries below the roots
/// need no per-entry view resolution: with thousands of secrets, that
/// resolution dominated setup. The canonical paths stay individually denied.
pub(super) fn expand_views(policy: &mut Policy) -> Result<(), Error> {
    let snapshot = views::snapshot()?;
    policy.mounts = snapshot.devices();
    let Some(project) = policy.project.clone() else {
        let keep = policy.allowed.clone();
        policy.credentials = snapshot.withheld(&policy.credentials, Some(&keep))?;
        policy.denied = snapshot.withheld(&policy.denied, Some(&keep))?;
        return Ok(());
    };
    let mut roots = policy.writable.clone();
    roots.push(project);
    policy.credentials = snapshot.withheld(&policy.credentials, Some(&roots))?;
    let views: BTreeSet<_> = snapshot
        .writable_views(&roots)?
        .into_iter()
        .filter(|view| !roots.contains(view))
        .map(|view| snapshot.coarse(&view, None, &roots))
        .collect();
    policy.views = views.into_iter().collect();
    if policy
        .views
        .iter()
        .any(|view| roots.iter().any(|root| root.starts_with(view)))
    {
        // A view enclosing a writable root cannot be withheld as a whole.
        policy.views.clear();
        policy.mask_scopes = snapshot.writable_views(&roots)?;
        policy.denied = snapshot.aliases(&policy.denied)?;
        policy.write_denied = snapshot.aliases(&policy.write_denied)?;
        policy.secrets = snapshot.aliases(&policy.secrets)?;
        return Ok(());
    }
    policy.mask_scopes = roots.iter().chain(&policy.views).cloned().collect();
    let close = |paths: &[PathBuf]| -> Result<Vec<PathBuf>, Error> {
        let (mut below, other): (Vec<_>, Vec<_>) = paths
            .iter()
            .cloned()
            .partition(|path| roots.iter().any(|root| path.starts_with(root)));
        below.extend(snapshot.withheld(&other, Some(&roots))?);
        below.extend(policy.views.iter().cloned());
        Ok(below)
    };
    policy.denied = close(&policy.denied)?;
    policy.write_denied = close(&policy.write_denied)?;
    Ok(())
}

pub(super) fn reason() -> &'static str {
    if std::fs::read_to_string("/proc/sys/kernel/apparmor_restrict_unprivileged_userns")
        .is_ok_and(|value| value.trim() == "1")
    {
        "linux_mountns_apparmor_userns_restricted"
    } else {
        "linux_mountns_unavailable"
    }
}

/// Masks existing secrets and hides other views of the writable roots.
/// With M+ requested, also binds the writable roots and returns the mounts
/// [`Sealing::seal`] makes read-only afterwards.
pub(super) fn mask(policy: &Policy) -> Result<Option<Sealing>, Error> {
    let root = policy.project.as_ref().ok_or("missing project")?;
    // A hidden view covers everything below it.
    let hidden = |path: &Path| {
        policy
            .views
            .iter()
            .any(|view| path != view && path.starts_with(view))
    };
    let mut secrets = policy.secrets.clone();
    secrets.retain(|path| !hidden(path));
    let inventoried: std::collections::HashSet<_> = policy.secrets.iter().collect();
    // Every list is already alias-closed (see expand_views).
    for path in policy.credentials.iter().chain(&policy.write_denied) {
        if inventoried.contains(path)
            || hidden(path)
            || !policy
                .mask_scopes
                .iter()
                .any(|scope| path.starts_with(scope))
        {
            continue;
        }
        if path == root || !path.exists() {
            return Err("private root cannot be masked".into());
        }
        secrets.push(path.clone());
    }
    if secrets.iter().any(|secret| {
        policy
            .writable
            .iter()
            .any(|scratch| scratch.starts_with(secret))
    }) {
        return Err("private mount overlaps writable scratch".into());
    }
    let secrets = collapse(outermost(secrets), &policy.mask_scopes)?;
    let mut ancestors = BTreeSet::new();
    for secret in &secrets {
        // Mount follows symlinks. Such an entry cannot be pinned by its name.
        if std::fs::symlink_metadata(secret)?.file_type().is_symlink() {
            return Err("secret symlink cannot be mount-pinned".into());
        }
        let scope = innermost_scope(secret, &policy.mask_scopes);
        let mut parent = secret.parent();
        while let Some(path) = parent
            .filter(|path| scope.is_some_and(|scope| *path != scope && path.starts_with(scope)))
        {
            ancestors.insert(path.to_path_buf());
            parent = path.parent();
        }
    }
    enter()?;
    // Bind the writable roots first, so masks below need no later copy.
    let sealing = policy
        .mountns_plus
        .then(|| harden::prepare(policy).ok())
        .flatten();
    for path in ancestors {
        bind(&path, &path, MsFlags::empty())?;
    }
    mask_entries(&secrets)?;
    Ok(sealing)
}

fn innermost_scope<'a>(path: &Path, scopes: &'a [PathBuf]) -> Option<&'a Path> {
    scopes
        .iter()
        .filter(|scope| path.starts_with(scope))
        .max_by_key(|scope| scope.components().count())
        .map(PathBuf::as_path)
}

// A masked directory already hides every descendant, including aliases
// that would otherwise disappear before their individual mount operation.
// Component order lists each path directly before its descendants.
fn outermost(mut secrets: Vec<PathBuf>) -> Vec<PathBuf> {
    secrets.sort();
    let mut kept: Vec<PathBuf> = Vec::with_capacity(secrets.len());
    for path in secrets {
        if !kept.last().is_some_and(|last| path.starts_with(last)) {
            kept.push(path);
        }
    }
    kept
}

/// One mask per directory whose entries are all masked, instead of one per
/// entry. The directory then reads as empty and refuses new entries (EROFS);
/// it hides no non-secret content, since it had none when the run started.
/// Scope roots stay writable; deeper levels collapse in turn.
fn collapse(secrets: Vec<PathBuf>, scopes: &[PathBuf]) -> Result<Vec<PathBuf>, Error> {
    let mut masked: HashSet<PathBuf> = secrets.into_iter().collect();
    loop {
        let mut groups: HashMap<&Path, usize> = HashMap::new();
        for path in &masked {
            if let Some(parent) = path.parent() {
                *groups.entry(parent).or_default() += 1;
            }
        }
        let mut full = Vec::new();
        for (parent, count) in groups {
            if count < 2
                || innermost_scope(parent, scopes).is_none_or(|scope| scope == parent)
                || std::fs::symlink_metadata(parent)?.file_type().is_symlink()
            {
                continue;
            }
            if std::fs::read_dir(parent)?.count() == count {
                full.push(parent.to_path_buf());
            }
        }
        if full.is_empty() {
            return Ok(masked.into_iter().collect());
        }
        let full: HashSet<_> = full.into_iter().collect();
        masked.retain(|path| path.parent().is_none_or(|parent| !full.contains(parent)));
        masked.extend(full);
    }
}

fn mask_entries(secrets: &[PathBuf]) -> Result<(), Error> {
    // A private tmpfs supplies empty bind sources. Detach before exec so the
    // command cannot mutate the source through a second pathname.
    let scratch = std::env::temp_dir().join(format!("butler-mask-{}", std::process::id()));
    std::fs::create_dir(&scratch)?;
    let result = mask_with_source(secrets, &scratch);
    let detached = nix::mount::umount2(&scratch, nix::mount::MntFlags::MNT_DETACH);
    let removed = std::fs::remove_dir(&scratch);
    result?;
    detached?;
    removed?;
    Ok(())
}

fn mask_with_source(secrets: &[PathBuf], scratch: &Path) -> Result<(), Error> {
    let source = Source::mount(scratch)?;
    source.seal(scratch)?;
    for path in secrets {
        source.cover(path)?;
    }
    Ok(())
}

/// An empty file and an inaccessible empty directory on a private tmpfs.
/// After `seal`, binds inherit its read-only, nosuid, nodev, noexec flags,
/// so each mask costs one mount call instead of a bind plus a remount.
struct Source {
    file: PathBuf,
    directory: PathBuf,
}

impl Source {
    fn mount(root: &Path) -> Result<Self, Error> {
        mount(
            Some("tmpfs"),
            root,
            Some("tmpfs"),
            MsFlags::MS_NOSUID | MsFlags::MS_NODEV,
            Some("mode=700"),
        )?;
        let source = Self {
            file: root.join("file"),
            directory: root.join("directory"),
        };
        use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o400)
            .open(&source.file)?;
        std::fs::DirBuilder::new()
            .mode(0o000)
            .create(&source.directory)?;
        Ok(source)
    }

    fn seal(&self, root: &Path) -> Result<(), Error> {
        mount(
            None::<&str>,
            root,
            None::<&str>,
            MsFlags::MS_REMOUNT
                | MsFlags::MS_RDONLY
                | MsFlags::MS_NOSUID
                | MsFlags::MS_NODEV
                | MsFlags::MS_NOEXEC,
            None::<&str>,
        )?;
        Ok(())
    }

    fn cover(&self, path: &Path) -> Result<(), Error> {
        let source = if std::fs::symlink_metadata(path)?.is_dir() {
            &self.directory
        } else {
            &self.file
        };
        bind(source, path, MsFlags::empty())
    }
}

#[cfg(feature = "test-support")]
pub(super) fn project_aliases(root: &Path) -> Result<Vec<PathBuf>, Error> {
    views::snapshot()?.aliases(&[crate::secure_fs::canonicalize(root)?])
}
