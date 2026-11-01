//! Literal .gitignore directory declarations, pre-created for Tier L.
use rustix::fs::{AtFlags, CWD, Mode, OFlags, mkdirat, openat, unlinkat};
use sha2::{Digest, Sha256};
use std::io;
use std::path::Path;

fn names(root: &Path) -> io::Result<Vec<String>> {
    let path = root.join(".gitignore");
    let fd = match openat(
        CWD,
        path,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
        Mode::empty(),
    ) {
        Ok(fd) => fd,
        Err(rustix::io::Errno::NOENT) => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    if rustix::fs::FileType::from_raw_mode(rustix::fs::fstat(&fd)?.st_mode)
        != rustix::fs::FileType::RegularFile
    {
        return Err(io::Error::other("gitignore must be a regular file"));
    }
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::from(fd)
        .take(65_537)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 65_536 {
        return Err(io::Error::other("gitignore size limit exceeded"));
    }
    let text = String::from_utf8(bytes).map_err(io::Error::other)?;
    let mut names = Vec::new();
    for line in text.lines() {
        let line = line.trim_end_matches(' ');
        if line.starts_with(['#', '!']) {
            continue;
        }
        let name = line.strip_prefix('/').unwrap_or(line);
        let name = name.strip_suffix('/').unwrap_or(name);
        if name.is_empty()
            || name == "."
            || name == ".."
            || name.contains(['/', '\\', '*', '?', '[', ']', '\0'])
            || crate::command_sandbox::secret_name(name)
            || names.iter().any(|item| item == name)
            || !std::fs::symlink_metadata(root.join(name))
                .is_err_and(|error| error.kind() == io::ErrorKind::NotFound)
        {
            continue;
        }
        names.push(name.to_owned());
        if names.len() == 32 {
            break;
        }
    }
    Ok(names)
}

fn journal_dir(root: &Path, data: &Path) -> io::Result<std::path::PathBuf> {
    use std::os::unix::ffi::OsStrExt;
    let real = crate::secure_fs::canonicalize(root)?;
    let digest = Sha256::digest(real.as_os_str().as_bytes());
    Ok(data
        .join(crate::data_paths::SANDBOX_GENERATED)
        .join(format!("{digest:x}")))
}

pub(super) fn prepare(
    root: &Path,
    data: &Path,
) -> io::Result<super::super::ProjectWritePreparation> {
    let dir = journal_dir(root, data)?;
    std::fs::create_dir_all(&dir)?;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(dir.join("lease"))?;
    let lease = nix::fcntl::Flock::lock(file, nix::fcntl::FlockArg::LockExclusive)
        .map_err(|(_, error)| io::Error::from(error))?;
    let prepared = super::super::ProjectWritePreparation { _lease: lease };
    cleanup(root, data, true)?;
    // Prepare on every tier: a project-specific mask failure falls back to
    // Tier L inside the helper, after this point. Tier M simply finds the
    // directories present, and empty ones are removed after the run.
    let fd = openat(
        CWD,
        root,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    let names = names(root)?;
    if names.is_empty() {
        return Ok(prepared);
    }
    let key = process_key(std::process::id())
        .ok_or_else(|| io::Error::other("cannot identify preparation owner"))?;
    let journal = dir.join(format!("{key}.json"));
    let mut recorded = if journal.exists() {
        serde_json::from_slice::<Vec<String>>(&std::fs::read(&journal)?)?
    } else {
        Vec::new()
    };
    recorded.extend(names.iter().cloned());
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(journal.with_extension("tmp"))?;
    serde_json::to_writer(&file, &recorded)?;
    file.sync_all()?;
    std::fs::rename(journal.with_extension("tmp"), &journal)?;
    std::fs::File::open(&dir)?.sync_all()?;
    for name in names {
        mkdirat(&fd, name.as_str(), Mode::from_bits_truncate(0o755))?;
    }
    Ok(prepared)
}

pub(super) fn cleanup(root: &Path, data: &Path, stale_only: bool) -> io::Result<()> {
    let dir = journal_dir(root, data)?;
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let fd = openat(
        CWD,
        root,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    for entry in entries {
        let entry = entry?;
        if entry
            .path()
            .extension()
            .is_none_or(|extension| extension != "json")
        {
            continue;
        }
        let pid = entry
            .path()
            .file_stem()
            .and_then(|name| name.to_str())
            .and_then(|name| name.split('-').next()?.parse::<u32>().ok())
            .unwrap_or(0);
        let live = process_key(pid).is_some_and(|key| {
            entry
                .path()
                .file_stem()
                .is_some_and(|name| name == key.as_str())
        });
        if live && (stale_only || pid != std::process::id()) {
            continue;
        }
        let names: Vec<String> = serde_json::from_slice(&std::fs::read(entry.path())?)?;
        for name in names {
            if name.is_empty()
                || name.contains(['/', '\0'])
                || name == "."
                || name == ".."
                || crate::command_sandbox::secret_name(&name)
            {
                return Err(io::Error::other("invalid generated journal"));
            }
            match unlinkat(&fd, name.as_str(), AtFlags::REMOVEDIR) {
                Ok(())
                | Err(
                    rustix::io::Errno::NOENT
                    | rustix::io::Errno::NOTEMPTY
                    | rustix::io::Errno::NOTDIR,
                ) => {}
                Err(error) => return Err(error.into()),
            }
        }
        std::fs::remove_file(entry.path())?;
    }
    Ok(())
}

fn process_key(pid: u32) -> Option<String> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let (_, fields) = stat.rsplit_once(") ")?;
    let started = fields.split_whitespace().nth(19)?;
    let boot = std::fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
    Some(format!("{pid}-{started}-{}", boot.trim()))
}
