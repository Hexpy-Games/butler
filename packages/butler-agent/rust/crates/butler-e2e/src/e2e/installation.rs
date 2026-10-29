//! Per-scenario immutable links, or independent writable installation files.
use std::{fs, io, path::Path};
pub mod snapshot;

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
        |_, _| {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "independent copy",
            ))
        },
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
            && fs::metadata(source)?.permissions().readonly()
            && link(source, staging).is_ok()
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
    tree(source, target, access, false)
}

/// Only harness-owned, already protected snapshots may supply shared inodes.
fn link_tree(source: &Path, target: &Path) -> io::Result<()> {
    tree(source, target, Access::Immutable, true)
}

fn tree(source: &Path, target: &Path, access: Access, links: bool) -> io::Result<()> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let path = target.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            tree(&entry.path(), &path, access, links)?;
        } else if entry.file_type()?.is_file() {
            if links {
                install_with(
                    &entry.path(),
                    &path,
                    access,
                    |from, to| fs::hard_link(from, to),
                    |from, to| fs::copy(from, to).map(|_| ()),
                )?;
            } else {
                install(&entry.path(), &path, access)?;
            }
        }
    }
    Ok(())
}
