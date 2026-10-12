//! Landlock cannot subtract paths. Grant siblings along denied ancestor chains,
//! traversing only those chains, never the workspace tree.
use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use landlock::{AccessFs, BitFlags, PathBeneath, PathFd, RulesetCreated, RulesetCreatedAttr};

use super::Error;

// Matches the current macOS login_shell_contained credential roots exactly.
const PRIVATE: &[&str] = &[
    ".ssh",
    ".gnupg",
    ".aws",
    ".kube",
    ".docker",
    ".netrc",
    ".git-credentials",
    "Library/Keychains",
    ".butler-e2e-auth",
];

pub(super) fn private_roots(
    environment: &HashMap<String, String>,
    denied: &[&Path],
    allowed: &[&Path],
) -> Vec<PathBuf> {
    let mut roots: Vec<_> = denied.iter().map(|path| path.to_path_buf()).collect();
    if !allowed.is_empty()
        && let Some(home) = environment.get("HOME")
    {
        roots.extend(PRIVATE.iter().map(|name| Path::new(home).join(name)));
    }
    roots
}

pub(super) fn apply(
    rules: &mut RulesetCreated,
    denied: &[PathBuf],
    allowed: &[PathBuf],
) -> Result<(), Error> {
    let private = aliases(denied)?;
    let mut blocked = private.clone();
    for root in allowed {
        blocked.extend(project_secrets(root)?);
    }
    // READ_DIR grants recurse too: permit directory names, while withholding
    // READ_FILE/EXECUTE prevents access to denied contents. Landlock cannot
    // hide directory entries without also preventing ordinary parent listings.
    grant(rules, Path::new("/"), AccessFs::ReadDir.into())?;
    let read = AccessFs::ReadFile | AccessFs::Execute;
    let wsl = Path::new("/proc/sys/fs/binfmt_misc/WSLInterop").exists()
        || std::fs::read_to_string("/proc/sys/kernel/osrelease")?
            .to_ascii_lowercase()
            .contains("microsoft");
    // Withhold execution on interop entry points even if a project lives on
    // a Windows mount. Read permissions there remain unchanged.
    let deny_execute = if wsl {
        aliases(&[PathBuf::from("/mnt"), PathBuf::from("/init")])?
    } else {
        Vec::new()
    };
    grant_complement(rules, Path::new("/"), &blocked, &deny_execute, read)?;
    // Private exclusions remain denied even when a workspace overlaps them.
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
    for entry in std::fs::read_dir(resolved_path(root)?)? {
        let entry = entry?;
        if secret_name(&entry.file_name().to_string_lossy()) {
            secrets.push(entry.path());
        }
    }
    // Do not deny a public external target merely because a secret-named
    // symlink points to it: Seatbelt does not deny that target either. The
    // lexical guard covers secret-named symlinks, which Landlock cannot carve
    // out independently of their target.
    Ok(secrets)
}

fn secret_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    matches!(
        name.as_str(),
        ".git"
            | ".ssh"
            | ".gnupg"
            | ".project-ledger"
            | "chatgpt-oauth.json"
            | "credentials.json"
            | "secrets.json"
            | "id_rsa"
            | "id_ed25519"
    ) || name.starts_with(".env")
        || name.ends_with(".pem")
        || name.ends_with(".key")
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
    let rights = if rights.contains(AccessFs::ReadDir) && !path.is_dir() {
        rights & !AccessFs::ReadDir
    } else {
        rights
    };
    if !rights.is_empty() {
        rules.add_rule(PathBeneath::new(PathFd::new(path)?, rights))?;
    }
    Ok(())
}
