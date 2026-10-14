//! Landlock cannot subtract paths. Grant siblings along denied ancestor chains,
//! traversing only those chains, never the workspace tree.
use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use landlock::{
    ABI, Access, AccessFs, BitFlags, PathBeneath, PathFd, RulesetCreated, RulesetCreatedAttr,
};

use super::Error;

pub(super) fn apply(
    rules: &mut RulesetCreated,
    denied: &[PathBuf],
    allowed: &[PathBuf],
    credentials: &[PathBuf],
) -> Result<(), Error> {
    let private = aliases(denied)?;
    let credentials = aliases(credentials)?;
    let projects = allowed
        .iter()
        .map(|root| {
            let real = resolved_path(root)?;
            let secrets = project_secrets(&real)?;
            Ok((real, secrets))
        })
        .collect::<Result<Vec<_>, Error>>()?;
    let mut blocked = private.clone();
    blocked.extend(credentials.iter().cloned());
    for (_, secrets) in &projects {
        blocked.extend(secrets.iter().cloned());
    }
    // READ_DIR grants recurse too: permit directory names, while withholding
    // READ_FILE/EXECUTE prevents access to denied contents. Landlock cannot
    // hide directory entries without also preventing ordinary parent listings.
    grant(rules, Path::new("/"), AccessFs::ReadDir.into())?;
    let read = AccessFs::ReadFile | AccessFs::Execute;
    let deny_execute = execution_denials()?;
    grant_complement(rules, Path::new("/"), &blocked, &deny_execute, read)?;
    for (real, secrets) in &projects {
        // Disjoint workspaces already received exactly these grants above.
        // Only private-root overlap needs Seatbelt's workspace exception.
        if !private
            .iter()
            .any(|path| real.starts_with(path) || path.starts_with(real))
        {
            continue;
        }
        let mut excluded: Vec<_> = private
            .iter()
            .filter(|path| !real.starts_with(path))
            .cloned()
            .collect();
        excluded.extend(credentials.iter().cloned());
        excluded.extend(secrets.iter().cloned());
        grant_complement(rules, real, &excluded, &deny_execute, read)?;
    }
    grant(rules, Path::new("/dev/null"), AccessFs::WriteFile.into())
}

fn aliases(paths: &[PathBuf]) -> Result<Vec<PathBuf>, Error> {
    let mut result = paths.to_vec();
    let mut resolved = HashMap::new();
    for path in paths {
        let real = canonical_or_missing(path, &mut resolved)?;
        if !result.contains(&real) {
            result.push(real);
        }
    }
    Ok(result)
}

// A missing credential root still needs its real ancestor chain denied, even
// when HOME is a symlink. No broad grant may cover a subsequently created root.
fn canonical_or_missing(
    path: &Path,
    resolved: &mut HashMap<PathBuf, PathBuf>,
) -> Result<PathBuf, Error> {
    if let Some(real) = resolved.get(path) {
        return Ok(real.clone());
    }
    let real = match resolved_path(path) {
        Ok(real) => real,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = path.parent().ok_or("private root has no parent")?;
            let name = path.file_name().ok_or("private root has no name")?;
            canonical_or_missing(parent, resolved)?.join(name)
        }
        Err(error) => return Err(error.into()),
    };
    // Per-policy only: missing credential siblings share the same ancestor,
    // but every command still observes current filesystem contents.
    resolved.insert(path.to_path_buf(), real.clone());
    Ok(real)
}

// Let the kernel resolve the complete path once, instead of userspace probing
// every component with readlink. O_PATH follows aliases without reading data.
// Keep the fd alive until procfs returns its physical path; on hosts without
// procfs, retain the standard canonicalization behavior.
fn resolved_path(path: &Path) -> std::io::Result<PathBuf> {
    use nix::{fcntl::OFlag, sys::stat::Mode};
    use std::os::fd::AsRawFd;
    let fd = nix::fcntl::open(path, OFlag::O_PATH | OFlag::O_CLOEXEC, Mode::empty())?;
    std::fs::read_link(format!("/proc/self/fd/{}", fd.as_raw_fd())).or_else(|_| path.canonicalize())
}

fn project_secrets(root: &Path) -> Result<Vec<PathBuf>, Error> {
    let mut secrets = Vec::new();
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        if super::super::credentials::secret_name(&entry.file_name().to_string_lossy()) {
            secrets.push(entry.path());
        }
    }
    // Do not deny a public external target merely because a secret-named
    // symlink points to it: Seatbelt does not deny that target either. The
    // lexical guard covers secret-named symlinks, which Landlock cannot carve
    // out independently of their target.
    Ok(secrets)
}

fn grant_complement(
    rules: &mut RulesetCreated,
    path: &Path,
    denied: &[PathBuf],
    deny_execute: &[PathBuf],
    rights: BitFlags<AccessFs>,
) -> Result<(), Error> {
    // Walk the physical tree. Rules on its directories/files already cover
    // accesses through aliases; adding symlink rules would duplicate grants
    // and could accidentally re-grant a denied target.
    let real = path;
    if denied.iter().any(|root| real.starts_with(root)) {
        return Ok(());
    }
    let rights = if deny_execute.iter().any(|root| real.starts_with(root)) {
        rights & !AccessFs::Execute
    } else {
        rights
    };
    if rights.is_empty() {
        return Ok(());
    }
    let mut child_rights = rights;
    if !denied.iter().any(|root| root.starts_with(real)) {
        if !rights.contains(AccessFs::Execute)
            || !deny_execute.iter().any(|root| root.starts_with(real))
        {
            return grant(rules, real, rights);
        }
        // Read access is unrestricted here; split only the execution grants.
        grant(rules, real, rights & !AccessFs::Execute)?;
        child_rights = AccessFs::Execute.into();
    }
    // No parent read grant: that would recursively re-allow its denied child.
    let split = split_children(real, denied, deny_execute);
    let parent = PathFd::new(real)?;
    for entry in std::fs::read_dir(real)? {
        let entry = entry?;
        if entry.file_type()?.is_symlink() {
            continue;
        }
        let name = entry.file_name();
        if split.contains(&name) {
            grant_complement(rules, &entry.path(), denied, deny_execute, child_rights)?;
        } else {
            grant_child(rules, &parent, &name, child_rights)?;
        }
    }
    Ok(())
}

// The resolved parent stays open across its siblings, avoiding repeated walks
// from /. Never follow a last-component alias that appeared after read_dir.
fn grant_child(
    rules: &mut RulesetCreated,
    parent: &PathFd,
    name: &OsStr,
    rights: BitFlags<AccessFs>,
) -> Result<(), Error> {
    use nix::{fcntl::OFlag, sys::stat::Mode};
    let fd = nix::fcntl::openat(
        parent,
        name,
        OFlag::O_PATH | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW,
        Mode::empty(),
    )?;
    let directory = !directory_only(rights)
        || nix::sys::stat::fstat(&fd)?.st_mode & nix::libc::S_IFMT == nix::libc::S_IFDIR;
    let rights = file_rights(rights, directory);
    rules.add_rule(PathBeneath::new(fd, rights))?;
    Ok(())
}

// Select exceptional branches once per directory. Ordinary siblings cannot
// contain a denied descendant; aliases receive their physical target's rights.
fn split_children(parent: &Path, denied: &[PathBuf], execute: &[PathBuf]) -> HashSet<OsString> {
    denied
        .iter()
        .chain(execute)
        .filter_map(|root| {
            root.strip_prefix(parent)
                .ok()?
                .components()
                .next()
                .map(|component| component.as_os_str().to_os_string())
        })
        .collect()
}

fn grant(rules: &mut RulesetCreated, path: &Path, rights: BitFlags<AccessFs>) -> Result<(), Error> {
    let rights = file_rights(rights, !directory_only(rights) || path.is_dir());
    if !rights.is_empty() {
        rules.add_rule(PathBeneath::new(PathFd::new(path)?, rights))?;
    }
    Ok(())
}

fn directory_only(rights: BitFlags<AccessFs>) -> bool {
    !(rights
        & !(AccessFs::ReadFile
            | AccessFs::Execute
            | AccessFs::WriteFile
            | AccessFs::Truncate
            | AccessFs::IoctlDev))
        .is_empty()
}

fn file_rights(rights: BitFlags<AccessFs>, directory: bool) -> BitFlags<AccessFs> {
    if directory {
        rights
    } else {
        rights
            & (AccessFs::ReadFile
                | AccessFs::Execute
                | AccessFs::WriteFile
                | AccessFs::Truncate
                | AccessFs::IoctlDev)
    }
}

pub(super) fn project_write(
    rules: &mut RulesetCreated,
    root: &Path,
    writable: &[PathBuf],
    denied: &[PathBuf],
    credentials: &[PathBuf],
    protected: &[PathBuf],
) -> Result<(), Error> {
    let mut blocked = aliases(denied)?;
    blocked.extend(aliases(credentials)?);
    blocked.extend(project_secrets(root)?);
    let rights = AccessFs::from_all(ABI::V3);
    let deny_execute = execution_denials()?;
    // Never grant the project root: create/remove/rename rights on it would
    // allow changing top-level protected names. Split ancestors of secrets.
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_dir() || kind.is_file() {
            grant_complement(rules, &entry.path(), &blocked, &deny_execute, rights)?;
        }
    }
    // Scratch is an explicit exception to private data-root exclusion, but
    // never to credential roots or existing project secret targets.
    // REFER is withheld everywhere else.
    let mut scratch_denied = aliases(credentials)?;
    let secrets: Vec<_> = protected
        .iter()
        .filter(|path| {
            path.file_name()
                .is_some_and(|name| super::super::secret_name(&name.to_string_lossy()))
        })
        .cloned()
        .collect();
    scratch_denied.extend(aliases(&secrets)?);
    for path in writable {
        grant_complement(rules, path, &scratch_denied, &deny_execute, rights)?;
    }
    Ok(())
}

fn execution_denials() -> Result<Vec<PathBuf>, Error> {
    let wsl = Path::new("/proc/sys/fs/binfmt_misc/WSLInterop").exists()
        || std::fs::read_to_string("/proc/sys/kernel/osrelease")?
            .to_ascii_lowercase()
            .contains("microsoft");
    // Withhold execution on interop entry points even if a project lives on
    // a Windows mount. Read permissions there remain unchanged.
    if wsl {
        aliases(&[PathBuf::from("/mnt"), PathBuf::from("/init")])
    } else {
        Ok(Vec::new())
    }
}
