//! Per-scenario immutable links, or independent writable installation files.
use std::{fs, io, path::Path};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Access {
    Immutable,
    Mutable,
}

/// Install a complete file without requesting crash durability in a test sandbox.
pub fn install(source: &Path, target: &Path, access: Access) -> io::Result<()> {
    install_with(
        source,
        target,
        access,
        |from, to| fs::hard_link(from, to),
        |from, to| fs::copy(from, to).map(|_| ()),
    )
}

/// Filesystem operations are supplied separately so unavailable fast paths can
/// be exercised deterministically, without assuming a particular mount layout.
pub fn install_with(
    source: &Path,
    target: &Path,
    access: Access,
    link: impl FnOnce(&Path, &Path) -> io::Result<()>,
    clone: impl FnOnce(&Path, &Path) -> io::Result<()>,
) -> io::Result<()> {
    super::executable::publish_path(target, |staging| {
        if access == Access::Immutable
            && butler_platform::command_sandbox::FixtureInstallation::HARD_LINKS
            && link_readonly(source, staging, link).is_ok()
        {
            return Ok(());
        }
        if clone(source, staging).is_err() {
            // A failed kernel copy may leave a partial file. Start afresh.
            match butler_platform::command_sandbox::FixtureInstallation::remove_staging(staging) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            let mut output = fs::File::create(staging)?;
            io::copy(&mut fs::File::open(source)?, &mut output)?;
            output.set_permissions(fs::metadata(source)?.permissions())?;
            // Closing, rather than syncing, prevents ETXTBSY and ensures the
            // subsequently published file has no outstanding writable handle.
            drop(output);
        }
        if access == Access::Mutable {
            butler_platform::plugin_files::protect(staging, false)
        } else {
            let mut permissions = fs::metadata(staging)?.permissions();
            permissions.set_readonly(true);
            fs::set_permissions(staging, permissions)
        }
    })
}

pub fn install_tree(source: &Path, target: &Path, access: Access) -> io::Result<()> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let path = target.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            install_tree(&entry.path(), &path, access)?;
        } else if entry.file_type()?.is_file() {
            install(&entry.path(), &path, access)?;
        }
    }
    Ok(())
}

fn link_readonly(
    source: &Path,
    target: &Path,
    link: impl FnOnce(&Path, &Path) -> io::Result<()>,
) -> io::Result<()> {
    // A chmod on a link changes its source too. Protect before sharing; if
    // protection is unavailable, use an independent copy instead.
    let mut permissions = fs::metadata(source)?.permissions();
    if !permissions.readonly() {
        permissions.set_readonly(true);
        fs::set_permissions(source, permissions)?;
    }
    link(source, target)
}
