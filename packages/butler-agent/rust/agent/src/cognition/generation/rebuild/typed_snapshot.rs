use std::{
    fs::{self, File, Metadata, OpenOptions},
    io,
    path::{Component, Path},
};

use crate::cognition::{CognitionError, CognitionResult, ensure_data_authority};

const TYPED_SOURCE_ROOTS: [&str; 4] = [
    "tasks",
    "cognition/memory/rules",
    "cognition/feedback",
    "butler.config.json",
];

pub(super) fn copy_typed_sources(data_root: &Path, snapshot_root: &Path) -> CognitionResult<()> {
    ensure_data_authority(data_root, &[snapshot_root])?;
    if snapshot_root.starts_with(data_root) {
        reject_symlink_components(data_root, snapshot_root)?;
    }
    let snapshot_metadata = fs::symlink_metadata(snapshot_root).map_err(io_error)?;
    if snapshot_metadata.file_type().is_symlink() || !snapshot_metadata.is_dir() {
        return Err(snapshot_changed());
    }

    let mut roots = Vec::with_capacity(TYPED_SOURCE_ROOTS.len());
    for relative in TYPED_SOURCE_ROOTS {
        let source = data_root.join(relative);
        let target = snapshot_root.join(relative);
        ensure_data_authority(data_root, &[&source, &target])?;
        reject_symlink_components(data_root, &source)?;
        reject_symlink_components(snapshot_root, &target)?;
        reject_existing_target(&target)?;

        let metadata = metadata_if_present(&source)?;
        if let Some(metadata) = &metadata {
            scan_source_tree(&source, metadata)?;
        }
        roots.push((source, target, metadata.is_some()));
    }

    for (source, target, present) in roots {
        if !present {
            continue;
        }
        if let Some(parent) = target.parent() {
            create_destination_parents(data_root, snapshot_root, parent)?;
        }
        copy_source_tree(data_root, snapshot_root, &source, &target)?;
    }

    sync_directory(snapshot_root)?;
    Ok(())
}

fn scan_source_tree(path: &Path, metadata: &Metadata) -> CognitionResult<()> {
    if metadata.file_type().is_symlink() {
        return Err(snapshot_changed());
    }
    if metadata.is_file() {
        return Ok(());
    }
    if !metadata.is_dir() {
        return Err(snapshot_changed());
    }

    for entry in fs::read_dir(path).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        let child = entry.path();
        let child_metadata = fs::symlink_metadata(&child).map_err(io_error)?;
        scan_source_tree(&child, &child_metadata)?;
    }
    Ok(())
}

fn copy_source_tree(
    data_root: &Path,
    snapshot_root: &Path,
    source: &Path,
    target: &Path,
) -> CognitionResult<()> {
    ensure_data_authority(data_root, &[source, target])?;
    reject_symlink_components(data_root, source)?;
    reject_symlink_components(snapshot_root, target)?;
    let metadata = fs::symlink_metadata(source).map_err(io_error)?;
    if metadata.file_type().is_symlink() {
        return Err(snapshot_changed());
    }

    if metadata.is_dir() {
        reject_existing_target(target)?;
        create_private_directory(data_root, target)?;
        if let Some(parent) = target.parent() {
            sync_directory(parent)?;
        }

        for entry in fs::read_dir(source).map_err(io_error)? {
            let entry = entry.map_err(io_error)?;
            let child_source = entry.path();
            let child_target = target.join(entry.file_name());
            copy_source_tree(data_root, snapshot_root, &child_source, &child_target)?;
        }
        sync_directory(target)?;
        return Ok(());
    }
    if !metadata.is_file() {
        return Err(snapshot_changed());
    }

    reject_existing_target(target)?;
    ensure_data_authority(data_root, &[source, target])?;
    let mut input = File::open(source).map_err(io_error)?;
    let opened_metadata = input.metadata().map_err(io_error)?;
    if !opened_metadata.is_file() || !same_file(&metadata, &opened_metadata) {
        return Err(snapshot_changed());
    }
    ensure_data_authority(data_root, &[source, target])?;
    let current_source = fs::symlink_metadata(source).map_err(io_error)?;
    if current_source.file_type().is_symlink() || !same_file(&opened_metadata, &current_source) {
        return Err(snapshot_changed());
    }

    let mut output = create_private_file(data_root, target)?;
    ensure_data_authority(data_root, &[source, target])?;
    reject_symlink_components(data_root, source)?;
    reject_symlink_components(snapshot_root, target)?;
    let output_metadata = output.metadata().map_err(io_error)?;
    let path_metadata = fs::symlink_metadata(target).map_err(io_error)?;
    if path_metadata.file_type().is_symlink() || !same_file(&output_metadata, &path_metadata) {
        return Err(snapshot_changed());
    }

    let copied = io::copy(&mut input, &mut output).map_err(io_error)?;
    let final_source_metadata = input.metadata().map_err(io_error)?;
    if copied != opened_metadata.len() || final_source_metadata.len() != opened_metadata.len() {
        return Err(snapshot_changed());
    }
    output.sync_all().map_err(io_error)?;
    if let Some(parent) = target.parent() {
        sync_directory(parent)?;
    }
    Ok(())
}

fn create_destination_parents(
    data_root: &Path,
    snapshot_root: &Path,
    destination_parent: &Path,
) -> CognitionResult<()> {
    let relative = destination_parent
        .strip_prefix(snapshot_root)
        .map_err(|_| CognitionError::new("memory_data_path_unsafe", "memory_data_path_unsafe"))?;
    let mut current = snapshot_root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            if matches!(component, Component::CurDir) {
                continue;
            }
            return Err(CognitionError::new(
                "memory_data_path_unsafe",
                "memory_data_path_unsafe",
            ));
        };
        current.push(name);
        ensure_data_authority(data_root, &[&current])?;
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(snapshot_changed());
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                create_private_directory(data_root, &current)?;
                if let Some(parent) = current.parent() {
                    sync_directory(parent)?;
                }
            }
            Err(error) => return Err(io_error(error)),
        }
    }
    Ok(())
}

fn reject_symlink_components(base: &Path, path: &Path) -> CognitionResult<()> {
    let relative = path
        .strip_prefix(base)
        .map_err(|_| CognitionError::new("memory_data_path_unsafe", "memory_data_path_unsafe"))?;
    let mut current = base.to_path_buf();
    for component in relative.components() {
        match component {
            Component::Normal(name) => current.push(name),
            Component::CurDir => continue,
            _ => {
                return Err(CognitionError::new(
                    "memory_data_path_unsafe",
                    "memory_data_path_unsafe",
                ));
            }
        }
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(CognitionError::new(
                    "memory_data_path_unsafe",
                    "memory_data_path_unsafe",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => break,
            Err(error) => return Err(io_error(error)),
        }
    }
    Ok(())
}

fn metadata_if_present(path: &Path) -> CognitionResult<Option<Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io_error(error)),
    }
}

fn reject_existing_target(path: &Path) -> CognitionResult<()> {
    match fs::symlink_metadata(path) {
        Ok(_) => Err(snapshot_changed()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io_error(error)),
    }
}

fn create_private_file(data_root: &Path, path: &Path) -> CognitionResult<File> {
    ensure_data_authority(data_root, &[path])?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(io_error)
}

fn create_private_directory(data_root: &Path, path: &Path) -> CognitionResult<()> {
    ensure_data_authority(data_root, &[path])?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = fs::DirBuilder::new();
        builder.recursive(false).mode(0o700);
        builder.create(path).map_err(io_error)?;
    }
    #[cfg(not(unix))]
    fs::create_dir(path).map_err(io_error)?;
    Ok(())
}

fn same_file(left: &Metadata, right: &Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        left.dev() == right.dev() && left.ino() == right.ino()
    }
    #[cfg(not(unix))]
    {
        left.len() == right.len() && left.modified().ok() == right.modified().ok()
    }
}

fn sync_directory(path: &Path) -> CognitionResult<()> {
    #[cfg(unix)]
    {
        File::open(path)
            .and_then(|directory| directory.sync_all())
            .map_err(io_error)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

fn snapshot_changed() -> CognitionError {
    CognitionError::new("memory_snapshot_changed", "memory_snapshot_changed")
}

fn io_error(error: io::Error) -> CognitionError {
    CognitionError::new("memory_snapshot_copy_failed", error.to_string())
}
