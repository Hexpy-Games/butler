//! Landlock cannot subtract paths. Grant siblings along denied ancestor chains,
//! traversing only those chains, never the workspace tree.
use std::collections::{BTreeSet, HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use landlock::{
    ABI, Access, AccessFs, BitFlags, PathBeneath, PathFd, RulesetCreated, RulesetCreatedAttr,
};

use super::Error;

/// Denied paths, and the directories on their ancestor chains by inode.
/// Landlock rules attach to inodes: a mount view (WSL's /mnt/wslg/distro
/// shows / again) can reach a chain directory, such as /mnt itself, under
/// another name. A beneath rule there would re-allow every denied path
/// below it, so chain directories never receive one under any name; their
/// contents are granted where the chain itself is split.
pub(super) struct Denied {
    paths: BTreeSet<PathBuf>,
    chain: HashSet<(u64, u64)>,
    /// Mount roots on devices without chain directories: no identity check
    /// needed (a stat of a WSL drvfs root is a round trip to Windows).
    foreign: HashSet<PathBuf>,
}

impl Denied {
    pub(super) fn new(
        paths: BTreeSet<PathBuf>,
        execute: &[PathBuf],
        mounts: &HashMap<PathBuf, u64>,
    ) -> Self {
        let mut seen = HashSet::new();
        let mut chain = HashSet::new();
        for path in paths.iter().chain(execute) {
            for ancestor in path.ancestors().skip(1) {
                if !seen.insert(ancestor) {
                    break;
                }
                if let Ok(metadata) = std::fs::metadata(ancestor) {
                    use std::os::unix::fs::MetadataExt;
                    chain.insert((metadata.dev(), metadata.ino()));
                }
            }
        }
        let devices: HashSet<_> = chain.iter().map(|(device, _)| *device).collect();
        let foreign = mounts
            .iter()
            .filter(|(_, device)| !devices.contains(device))
            .map(|(target, _)| target.clone())
            .collect();
        Self {
            paths,
            chain,
            foreign,
        }
    }

    fn chained(&self, dev: u64, ino: u64) -> bool {
        self.chain.contains(&(dev, ino))
    }
}

pub(super) fn apply(
    rules: &mut RulesetCreated,
    denied: &[PathBuf],
    allowed: &[PathBuf],
    credentials: &[PathBuf],
    masked: &[PathBuf],
    mounts: &HashMap<PathBuf, u64>,
    timing: &mut super::timing::Timing,
) -> Result<(), Error> {
    // The trampoline already closed both lists over aliases and mount views.
    let masked: HashSet<_> = masked.iter().collect();
    let private: Vec<_> = denied
        .iter()
        .filter(|path| !masked.contains(path))
        .cloned()
        .collect();
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
    timing.mark("projects_rescan");
    let deny_execute = execution_denials()?;
    timing.mark("execution_denials");
    let blocked = Denied::new(blocked.into_iter().collect(), &deny_execute, mounts);
    timing.mark("denied_chain");
    // READ_DIR grants recurse too: permit directory names, while withholding
    // READ_FILE/EXECUTE prevents access to denied contents. Landlock cannot
    // hide directory entries without also preventing ordinary parent listings.
    grant(rules, Path::new("/"), AccessFs::ReadDir.into(), None)?;
    let read = AccessFs::ReadFile | AccessFs::Execute;
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
        let excluded = Denied::new(excluded.into_iter().collect(), &deny_execute, mounts);
        grant_complement(rules, real, &excluded, &deny_execute, read)?;
    }
    timing.mark("grant_complement");
    grant(
        rules,
        Path::new("/dev/null"),
        AccessFs::WriteFile.into(),
        None,
    )
}

/// Aliases of entries from a no-follow walk below a real root. Each such
/// path is already canonical unless the entry itself is a symlink, so only
/// symlinks need resolution (one lstat per entry instead of a full resolve).
pub(super) fn entry_aliases(paths: Vec<PathBuf>) -> Result<Vec<PathBuf>, Error> {
    let mut resolved = HashMap::new();
    let mut targets = Vec::new();
    for path in &paths {
        let metadata = match std::fs::symlink_metadata(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            result => result?,
        };
        if metadata.file_type().is_symlink() {
            targets.push(canonical_or_missing(path, &mut resolved)?);
        }
    }
    let mut result = paths;
    let mut seen: HashSet<_> = result.iter().cloned().collect();
    result.extend(
        targets
            .into_iter()
            .filter(|target| seen.insert(target.clone())),
    );
    Ok(result)
}

pub(super) fn aliases(paths: &[PathBuf]) -> Result<Vec<PathBuf>, Error> {
    let mut result = paths.to_vec();
    let mut seen: HashSet<_> = paths.iter().cloned().collect();
    let mut resolved = HashMap::new();
    for path in paths {
        let real = canonical_or_missing(path, &mut resolved)?;
        if seen.insert(real.clone()) {
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
            let parent = canonical_or_missing(parent, resolved)?;
            let candidate = parent.join(name);
            // Resolve a dangling leaf only after sharing the parent's result.
            // Expanding the full path here would rewalk every ancestor.
            match std::fs::read_link(&candidate) {
                Ok(_) => super::unresolved::target(&candidate)?,
                Err(_) => candidate,
            }
        }
        Err(error)
            if error.kind() == std::io::ErrorKind::PermissionDenied
                || error.raw_os_error() == Some(nix::libc::ELOOP) =>
        {
            super::unresolved::target(path)?
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
pub(in crate::command_sandbox) fn resolved_path(path: &Path) -> std::io::Result<PathBuf> {
    use nix::{fcntl::OFlag, sys::stat::Mode};
    use std::os::fd::AsRawFd;
    let fd = nix::fcntl::open(path, OFlag::O_PATH | OFlag::O_CLOEXEC, Mode::empty())?;
    std::fs::read_link(format!("/proc/self/fd/{}", fd.as_raw_fd()))
        .or_else(|_| crate::secure_fs::canonicalize(&path))
}

pub(super) fn project_secrets(root: &Path) -> Result<Vec<PathBuf>, Error> {
    let mut secrets = Vec::new();
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        if super::super::credentials::secret_name(&entry.file_name().to_string_lossy()) {
            secrets.push(entry.path());
        }
    }
    // A protected name protects the object too, including external targets.
    // Resolve before complement grants can recursively re-allow that object.
    entry_aliases(secrets)
}

fn grant_complement(
    rules: &mut RulesetCreated,
    path: &Path,
    denied: &Denied,
    deny_execute: &[PathBuf],
    rights: BitFlags<AccessFs>,
) -> Result<(), Error> {
    // Walk the physical tree. Rules on its directories/files already cover
    // accesses through aliases; adding symlink rules would duplicate grants
    // and could accidentally re-grant a denied target.
    if path
        .ancestors()
        .any(|ancestor| denied.paths.contains(ancestor))
    {
        return Ok(());
    }
    grant_below(rules, path, denied, deny_execute, rights)
}

// Only the top call checks ancestors: a split child's ancestors were not
// denied, or its parent would not have been entered.
fn grant_below(
    rules: &mut RulesetCreated,
    real: &Path,
    denied: &Denied,
    deny_execute: &[PathBuf],
    rights: BitFlags<AccessFs>,
) -> Result<(), Error> {
    if denied.paths.contains(real) {
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
    if !denied
        .paths
        .range(real.to_path_buf()..)
        .next()
        .is_some_and(|root| root.starts_with(real))
    {
        if !rights.contains(AccessFs::Execute)
            || !deny_execute.iter().any(|root| root.starts_with(real))
        {
            return grant(rules, real, rights, Some(denied));
        }
        // Read access is unrestricted here; split only the execution grants.
        grant(rules, real, rights & !AccessFs::Execute, Some(denied))?;
        child_rights = AccessFs::Execute.into();
    }
    // No parent read grant: that would recursively re-allow its denied child.
    let split = split_children(real, &denied.paths, deny_execute);
    let parent = PathFd::new(real)?;
    let entries = match std::fs::read_dir(real) {
        // Unlistable: none of its entries is granted.
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => return Ok(()),
        result => result?,
    };
    for entry in entries {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            continue;
        }
        let name = entry.file_name();
        if split.contains(&name) {
            grant_below(rules, &entry.path(), denied, deny_execute, child_rights)?;
        } else {
            let identify = kind.is_dir() && !denied.foreign.contains(&entry.path());
            grant_child(rules, &parent, &name, child_rights, denied, identify)?;
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
    denied: &Denied,
    identify: bool,
) -> Result<(), Error> {
    use nix::{fcntl::OFlag, sys::stat::Mode};
    // An entry the user cannot reach (e.g. Windows' pagefile.sys on drvfs)
    // simply gets no rule: withholding a grant never widens access.
    let fd = match nix::fcntl::openat(
        parent,
        name,
        OFlag::O_PATH | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW,
        Mode::empty(),
    ) {
        Err(nix::errno::Errno::EACCES | nix::errno::Errno::ENOENT) => return Ok(()),
        result => result?,
    };
    // The listing names each entry's type: only directories may be chain
    // directories under another name (and directory-only rights need a
    // type). Cached attributes suffice for type and identity.
    let stat = if identify || directory_only(rights) {
        use rustix::fs::{AtFlags, StatxFlags};
        Some(rustix::fs::statx(
            &fd,
            "",
            AtFlags::EMPTY_PATH | AtFlags::STATX_DONT_SYNC,
            StatxFlags::TYPE | StatxFlags::INO,
        )?)
    } else {
        None
    };
    let directory =
        stat.is_some_and(|stat| u32::from(stat.stx_mode) & nix::libc::S_IFMT == nix::libc::S_IFDIR);
    // Another view of a chain directory: its split name grants its contents.
    if directory
        && stat.is_some_and(|stat| {
            let device = rustix::fs::makedev(stat.stx_dev_major, stat.stx_dev_minor);
            denied.chained(device, stat.stx_ino)
        })
    {
        return Ok(());
    }
    let rights = file_rights(rights, !directory_only(rights) || directory);
    rules.add_rule(PathBeneath::new(fd, rights))?;
    Ok(())
}

// Select exceptional branches once per directory. Ordinary siblings cannot
// contain a denied descendant; aliases receive their physical target's rights.
fn split_children(
    parent: &Path,
    denied: &BTreeSet<PathBuf>,
    execute: &[PathBuf],
) -> HashSet<OsString> {
    denied
        .range(parent.to_path_buf()..)
        .take_while(|root| root.starts_with(parent))
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

fn grant(
    rules: &mut RulesetCreated,
    path: &Path,
    rights: BitFlags<AccessFs>,
    denied: Option<&Denied>,
) -> Result<(), Error> {
    let metadata = std::fs::metadata(path)?;
    if metadata.is_dir()
        && denied.is_some_and(|denied| {
            use std::os::unix::fs::MetadataExt;
            denied.chained(metadata.dev(), metadata.ino())
        })
    {
        return Ok(());
    }
    let rights = file_rights(rights, !directory_only(rights) || metadata.is_dir());
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
    policy: &super::Policy,
    mounted: bool,
    mounts: &HashMap<PathBuf, u64>,
) -> Result<(), Error> {
    let root = policy.project.as_deref().ok_or("missing project")?;
    let rights = AccessFs::from_all(ABI::V3) & !(AccessFs::MakeChar | AccessFs::MakeBlock);
    let deny_execute = execution_denials()?;
    // Tier L never grants the project root: create/remove/rename rights on it would
    // allow changing top-level protected names. Split ancestors of secrets.
    if mounted {
        let none = Denied::new(BTreeSet::new(), &[], mounts);
        grant_complement(rules, root, &none, &deny_execute, rights)?;
    } else {
        let mut blocked = policy.write_denied.clone();
        blocked.extend(policy.credentials.iter().cloned());
        blocked.extend(project_secrets(root)?);
        let blocked = Denied::new(blocked.into_iter().collect(), &deny_execute, mounts);
        for entry in std::fs::read_dir(root)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_dir() || kind.is_file() {
                grant_complement(rules, &entry.path(), &blocked, &deny_execute, rights)?;
            }
        }
    }
    // Scratch is an explicit exception to private data-root exclusion, but
    // never to credential roots or existing project secret targets.
    // REFER is withheld everywhere else.
    // Denials are alias-closed: a secret symlink's target is denied too, and
    // it is kept out of scratch even when its own name looks ordinary.
    let mut scratch_denied: BTreeSet<_> = policy.credentials.iter().cloned().collect();
    scratch_denied.extend(
        policy
            .denied
            .iter()
            .filter(|path| !mounted || !path.starts_with(root))
            .filter(|path| {
                path.file_name()
                    .is_some_and(|name| super::super::secret_name(&name.to_string_lossy()))
                    || policy
                        .writable
                        .iter()
                        .any(|scratch| path.starts_with(scratch))
            })
            .cloned(),
    );
    let scratch = Denied::new(scratch_denied, &deny_execute, mounts);
    for path in &policy.writable {
        grant_complement(rules, path, &scratch, &deny_execute, rights)?;
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
