//! Private mount namespace; failures never authorize a broader Landlock grant.
use super::{Error, Policy};
use nix::mount::{MsFlags, mount};
use nix::sched::{CloneFlags, unshare};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
mod cache;
mod views;
#[derive(Clone, Copy, serde::Serialize, serde::Deserialize)]
pub(super) enum Tier {
    L,
    M,
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

fn bind_readonly(source: &Path, target: &Path) -> Result<(), Error> {
    mount(
        Some(source),
        target,
        None::<&str>,
        MsFlags::MS_BIND,
        None::<&str>,
    )?;
    mount(
        None::<&str>,
        target,
        None::<&str>,
        MsFlags::MS_BIND
            | MsFlags::MS_REMOUNT
            | MsFlags::MS_RDONLY
            | MsFlags::MS_NOSUID
            | MsFlags::MS_NODEV
            | MsFlags::MS_NOEXEC,
        None::<&str>,
    )?;
    Ok(())
}

pub(super) fn probe_child() -> Result<(), Error> {
    enter()?;
    let root = std::env::temp_dir().join(format!("butler-mount-probe-{}", std::process::id()));
    std::fs::create_dir(&root)?;
    let result = probe_mount(&root).map(|()| println!("M"));
    // The namespace disappears on exit; the underlying directory is empty.
    let _ = nix::mount::umount2(&root, nix::mount::MntFlags::MNT_DETACH);
    let _ = std::fs::remove_dir(&root);
    result
}

fn probe_mount(root: &Path) -> Result<(), Error> {
    mount(
        Some("tmpfs"),
        root,
        Some("tmpfs"),
        MsFlags::MS_NOSUID | MsFlags::MS_NODEV,
        Some("mode=700"),
    )?;
    let (source, target) = (root.join("source"), root.join("target"));
    std::fs::write(&source, [])?;
    std::fs::write(&target, [])?;
    bind_readonly(&source, &target)?;
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
pub(super) fn expand_views(policy: &mut Policy) -> Result<(), Error> {
    let snapshot = views::snapshot()?;
    policy.denied = snapshot.aliases(&policy.denied)?;
    policy.credentials = snapshot.aliases(&policy.credentials)?;
    policy.write_denied = snapshot.aliases(&policy.write_denied)?;
    policy.secrets = snapshot.aliases(&super::complement::aliases(&policy.secrets)?)?;
    let mut writable = policy.writable.clone();
    writable.extend(policy.project.iter().cloned());
    policy.mask_scopes = snapshot.writable_views(&writable)?;
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

pub(super) fn mask(policy: &Policy) -> Result<(), Error> {
    let root = policy.project.as_ref().ok_or("missing project")?;
    let mut secrets = policy.secrets.clone();
    let inventoried: std::collections::HashSet<_> = secrets.iter().collect();
    let protected: Vec<_> = policy
        .credentials
        .iter()
        .chain(&policy.write_denied)
        .filter(|path| !inventoried.contains(path))
        .cloned()
        .collect();
    for path in super::complement::aliases(&protected)? {
        if !policy
            .mask_scopes
            .iter()
            .any(|scope| path.starts_with(scope))
        {
            continue;
        }
        if path == *root || !path.exists() {
            return Err("private root cannot be masked".into());
        }
        secrets.push(path);
    }
    if secrets.iter().any(|secret| {
        policy
            .writable
            .iter()
            .any(|scratch| scratch.starts_with(secret))
    }) {
        return Err("private mount overlaps writable scratch".into());
    }
    secrets.sort();
    secrets.dedup();
    // A masked directory already hides every descendant, including aliases
    // that would otherwise disappear before their individual mount operation.
    let roots: BTreeSet<_> = secrets.iter().cloned().collect();
    secrets.retain(|path| {
        !path
            .ancestors()
            .skip(1)
            .any(|parent| roots.contains(parent))
    });
    let mut ancestors = BTreeSet::new();
    for secret in &secrets {
        // Mount follows symlinks. Such an entry cannot be pinned by its name.
        if std::fs::symlink_metadata(secret)?.file_type().is_symlink() {
            return Err("secret symlink cannot be mount-pinned".into());
        }
        let mut parent = secret.parent();
        let scope = policy
            .mask_scopes
            .iter()
            .filter(|scope| secret.starts_with(scope))
            .max_by_key(|scope| scope.components().count());
        while let Some(path) = parent
            .filter(|path| scope.is_some_and(|scope| *path != scope && path.starts_with(scope)))
        {
            ancestors.insert(path.to_path_buf());
            parent = path.parent();
        }
    }
    enter()?;
    for path in ancestors {
        mount(
            Some(path.as_path()),
            &path,
            None::<&str>,
            MsFlags::MS_BIND,
            None::<&str>,
        )?;
    }
    mask_entries(&secrets)
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
    mount(
        Some("tmpfs"),
        scratch,
        Some("tmpfs"),
        MsFlags::MS_NOSUID | MsFlags::MS_NODEV,
        Some("mode=700"),
    )?;
    let empty = scratch.join("empty");
    std::fs::write(&empty, [])?;
    mount(
        None::<&str>,
        scratch,
        None::<&str>,
        MsFlags::MS_REMOUNT
            | MsFlags::MS_RDONLY
            | MsFlags::MS_NOSUID
            | MsFlags::MS_NODEV
            | MsFlags::MS_NOEXEC,
        None::<&str>,
    )?;
    for path in secrets {
        if path.is_dir() {
            mount(
                Some("tmpfs"),
                path,
                Some("tmpfs"),
                MsFlags::MS_RDONLY | MsFlags::MS_NOSUID | MsFlags::MS_NODEV | MsFlags::MS_NOEXEC,
                Some("mode=000"),
            )?;
        } else {
            bind_readonly(&empty, path)?;
        }
    }
    Ok(())
}

#[cfg(feature = "test-support")]
pub(super) fn project_aliases(root: &Path) -> Result<Vec<PathBuf>, Error> {
    views::snapshot()?.aliases(&[root.canonicalize()?])
}
