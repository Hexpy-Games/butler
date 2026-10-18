//! Only called under DATA ownership, before writers open or after every writer closes.
use super::{
    journal::{self, Journal, Phase},
    plan,
};
use butler_platform::secure_fs;
use std::{fs, io, path::Path, time::Instant};

pub(crate) fn apply(root: &Path, journal: &mut Journal) -> io::Result<bool> {
    if matches!(journal.phase, Phase::RollingBack) {
        rollback(root, journal)?;
        return Ok(false);
    }
    let started = Instant::now();
    // Writers may have committed new top-level files since preflight. Merge
    // this bounded listing with the durable plan so moved sources remain known.
    for path in plan::collect(root)? {
        if !journal.moves.contains(&path) {
            journal.moves.push(path);
        }
    }
    journal.save(root)?;
    let result = move_all(root, journal).and_then(|()| {
        journal::write_generation(root, &journal.new_generation)?;
        journal.phase = Phase::Applied;
        journal.save(root)
    });
    if result.is_err() {
        journal.phase = Phase::RollingBack;
        journal.save(root)?;
        rollback(root, journal)?;
        return Ok(false);
    }
    butler_core::diagnostic!(
        "[full-reset] applied renames={} elapsed_ms={}",
        journal.moves.len(),
        started.elapsed().as_millis()
    );
    Ok(true)
}
fn move_all(root: &Path, journal: &Journal) -> io::Result<()> {
    let trash = journal.trash(root);
    match fs::symlink_metadata(&trash) {
        Ok(m) if !m.is_dir() || m.file_type().is_symlink() => {
            return Err(io::Error::other("Invalid reset trash"));
        }
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => secure_fs::create_private_dir(&trash)?,
        Err(e) => return Err(e),
    }
    journal::sync(root)?;
    for relative in &journal.moves {
        let from = root.join(relative);
        let to = trash.join(relative);
        match fs::symlink_metadata(&from) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e),
            Ok(_) => {}
        }
        match fs::symlink_metadata(&to) {
            Ok(_) => return Err(io::Error::other("Reset destination already exists")),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        let parent = to
            .parent()
            .ok_or_else(|| io::Error::other("Invalid reset path"))?;
        secure_fs::create_private_dir_all(parent)?;
        secure_fs::rename(&from, &to)?;
        journal::sync(
            from.parent()
                .ok_or_else(|| io::Error::other("Invalid reset path"))?,
        )?;
        journal::sync(parent)?;
        secure_fs::fault_checkpoint("data_reset.move")?;
        secure_fs::abort_point("data_reset.move");
        secure_fs::hold_point("data_reset.move", || false)?;
    }
    Ok(())
}
fn rollback(root: &Path, journal: &mut Journal) -> io::Result<()> {
    let trash = journal.trash(root);
    for relative in journal.moves.iter().rev() {
        let from = trash.join(relative);
        match fs::symlink_metadata(&from) {
            Ok(_) => {
                let to = root.join(relative);
                if fs::symlink_metadata(&to).is_ok() {
                    return Err(io::Error::other("Rollback source occupied"));
                }
                secure_fs::rename(&from, &to)?;
                journal::sync(
                    from.parent()
                        .ok_or_else(|| io::Error::other("Invalid reset path"))?,
                )?;
                journal::sync(
                    to.parent()
                        .ok_or_else(|| io::Error::other("Invalid reset path"))?,
                )?;
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    journal::write_generation(root, &journal.old_generation)?;
    secure_fs::remove_tree(&trash)?;
    journal::sync(root)?;
    journal.phase = Phase::Failed;
    journal.save(root)
}
