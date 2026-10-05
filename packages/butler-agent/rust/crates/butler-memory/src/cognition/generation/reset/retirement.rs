//! Reader-drain reclamation; the receipt remains recoverable after any rename.
use super::*;

pub(super) fn retire(
    root: PathBuf,
    paths: CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    mut result: ResetResult,
    token: CancellationToken,
) {
    let old = paths
        .memory_root(&root)
        .join("generations")
        .join(&result.old_generation);
    let runtime = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        super::super::pins::mark_retiring(&old);
        crate::cognition::registration::retire_idle_graphs(&old.join("graph.sqlite"));
        super::super::pins::on_drain(
            &old.clone(),
            Box::new(move || {
                runtime.spawn(async move {
                    let Ok(lease) = acquire(&root, &paths, &coordinator, &token).await else {
                        return;
                    };
                    let removed = tokio::task::spawn_blocking(move || {
                        validate(&root, &paths, &result.operation_id)?;
                        check(&token)?;
                        let active =
                            resolve_active_generation(&root, &paths).map_err(io::Error::other)?;
                        if active.generation_id == result.old_generation {
                            return Err(io::Error::other("Memory changed"));
                        }
                        let trash = paths
                            .memory_root(&root)
                            .join("management/resets")
                            .join(&result.operation_id)
                            .join("retired");
                        crate::coordination::ensure_data_authority(&root, &[&old, &trash])?;
                        crate::cognition::lance_store::forget(
                            &old.join("butler.lance"),
                            "butler_memory",
                        );
                        if old.exists() {
                            butler_platform::secure_fs::rename(&old, &trash)?;
                            butler_platform::secure_fs::sync_path(
                                trash
                                    .parent()
                                    .ok_or_else(|| io::Error::other("Invalid reset path"))?,
                            )?;
                            butler_platform::secure_fs::sync_path(
                                old.parent()
                                    .ok_or_else(|| io::Error::other("Invalid reset path"))?,
                            )?;
                        }
                        if trash.exists() {
                            remove_tree(&root, &trash, &token)?;
                        }
                        result.removal_pending = false;
                        result.sequence += 1;
                        save(&root, &paths, &result)?;
                        lease.release(true).map_err(io::Error::other)
                    })
                    .await;
                    if !matches!(removed, Ok(Ok(()))) {
                        butler_core::diagnostic!("[memory-reset-retirement] {:?}", removed);
                    }
                });
            }),
        );
    });
}

pub(super) fn remove_tree(data: &Path, path: &Path, token: &CancellationToken) -> io::Result<()> {
    check(token)?;
    crate::cognition::ensure_data_authority(data, &[path]).map_err(io::Error::other)?;
    let metadata = fs::symlink_metadata(path)?;
    if metadata.is_symlink() {
        return Err(io::Error::other("Linked retirement artifact"));
    }
    if metadata.is_dir() {
        for entry in fs::read_dir(path)? {
            remove_tree(data, &entry?.path(), token)?;
        }
        fs::remove_dir(path)
    } else {
        butler_platform::secure_fs::remove_tree(path)
    }
}
