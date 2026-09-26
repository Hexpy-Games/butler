use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::Value;

use crate::cognition::{CognitionPathEnvironment, CognitionResult, mutable_paths};

use super::{
    CognitionNamespaceMigrationManifest, CognitionNamespaceMigrationPlan, FileStats, MigrationMove,
    SCHEMA, failure,
};

pub(super) fn build_plan(
    data_root: &Path,
    paths: &CognitionPathEnvironment,
) -> CognitionResult<CognitionNamespaceMigrationPlan> {
    let legacy = data_root.join("memory");
    let cognition = paths.cognition_root(data_root);
    let memory = paths.memory_root(data_root);
    let migration = cognition.join("migration");
    let manifest = migration.join("namespace-v1.json");
    let roots: [&Path; 5] = [&legacy, &cognition, &memory, &migration, &manifest];
    mutable_paths::ensure_data_authority(data_root, &roots)?;
    let legacy_stats = file_stats(data_root, &legacy)?;
    let memory_stats = file_stats(data_root, &memory)?;
    let legacy_exists = legacy.try_exists().unwrap_or(false);
    let memory_exists = memory.try_exists().unwrap_or(false);
    let prior_applied = read_manifest_status(&manifest) == Some("applied");
    let conflicts = if legacy_stats.files > 0 && memory_stats.files > 0 && !prior_applied {
        vec!["legacy and cognition memory roots both contain active data".to_owned()]
    } else {
        Vec::new()
    };
    let status = if !conflicts.is_empty() {
        "conflict"
    } else if prior_applied {
        "applied"
    } else if legacy_stats.files > 0 {
        "ready"
    } else if memory_stats.files > 0 {
        "applied"
    } else {
        "not_needed"
    };
    Ok(CognitionNamespaceMigrationPlan {
        schema: SCHEMA,
        status: status.to_owned(),
        legacy_memory_root: legacy.to_string_lossy().into_owned(),
        cognition_root: cognition.to_string_lossy().into_owned(),
        cognition_memory_root: memory.to_string_lossy().into_owned(),
        migration_root: migration.to_string_lossy().into_owned(),
        manifest_path: manifest.to_string_lossy().into_owned(),
        legacy_exists,
        cognition_memory_exists: memory_exists,
        legacy_file_count: legacy_stats.files,
        legacy_byte_count: legacy_stats.bytes,
        cognition_memory_file_count: memory_stats.files,
        cognition_memory_byte_count: memory_stats.bytes,
        conflicts,
        raw_text_included: false,
        dry_run: false,
    })
}

pub(super) fn apply_locked(
    data_root: &Path,
    paths: &CognitionPathEnvironment,
) -> CognitionResult<CognitionNamespaceMigrationManifest> {
    let cognition_root = paths.cognition_root(data_root);
    let migration_root = cognition_root.join("migration");
    let lock_path = migration_root.join("namespace-v1.lock");
    mutable_paths::ensure_data_authority(
        data_root,
        &[&cognition_root, &migration_root, &lock_path],
    )?;
    if let Some(parent) = lock_path.parent() {
        create_private_dir(parent)?;
    }
    let mut lock_options = OpenOptions::new();
    lock_options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        lock_options.mode(0o600);
    }
    let lock = match lock_options.open(&lock_path) {
        Ok(lock) => lock,
        Err(error) => {
            let plan = build_plan(data_root, paths)?;
            let failed = make_manifest(
                &plan,
                iso(now_millis()),
                now_millis(),
                None,
                Vec::new(),
                vec![error.to_string()],
                "failed",
            );
            write_manifest(data_root, Path::new(&plan.manifest_path), &failed)?;
            return Ok(failed);
        }
    };
    let result = (|| {
        let plan = build_plan(data_root, paths)?;
        match apply_plan(data_root, &plan) {
            Ok(manifest) => Ok(manifest),
            Err(error) => {
                let failed = make_manifest(
                    &plan,
                    iso(now_millis()),
                    now_millis(),
                    None,
                    Vec::new(),
                    vec![error.message],
                    "failed",
                );
                write_manifest(data_root, Path::new(&plan.manifest_path), &failed)?;
                Ok(failed)
            }
        }
    })();
    drop(lock);
    let _ = fs::remove_file(&lock_path);
    result
}

fn apply_plan(
    data_root: &Path,
    plan: &CognitionNamespaceMigrationPlan,
) -> CognitionResult<CognitionNamespaceMigrationManifest> {
    let started_ms = now_millis();
    let started_at = iso(started_ms);
    if !plan.conflicts.is_empty() {
        let manifest = make_manifest(
            plan,
            started_at,
            now_millis(),
            None,
            Vec::new(),
            plan.conflicts.clone(),
            "conflict",
        );
        write_manifest(data_root, Path::new(&plan.manifest_path), &manifest)?;
        return Ok(manifest);
    }

    let legacy = PathBuf::from(&plan.legacy_memory_root);
    let target = PathBuf::from(&plan.cognition_memory_root);
    let migration = PathBuf::from(&plan.migration_root);
    let mut backup_root = None;
    let mut moved_paths = Vec::new();
    if plan.status == "ready" {
        let backup = migration
            .join("backup")
            .join(format!("memory-{}", now_millis()));
        copy_tree(data_root, &legacy, &backup)?;
        move_directory(data_root, &legacy, &target)?;
        backup_root = Some(backup.to_string_lossy().into_owned());
        moved_paths.push(MigrationMove {
            from: legacy.to_string_lossy().into_owned(),
            to: target.to_string_lossy().into_owned(),
        });
    } else {
        mutable_paths::ensure_data_authority(data_root, &[&target])?;
        create_private_dir(&target)?;
    }
    let manifest = make_manifest(
        plan,
        started_at,
        now_millis(),
        backup_root,
        moved_paths,
        Vec::new(),
        "applied",
    );
    write_manifest(data_root, Path::new(&plan.manifest_path), &manifest)?;
    Ok(manifest)
}

fn make_manifest(
    plan: &CognitionNamespaceMigrationPlan,
    started_at: String,
    completed_ms: i64,
    backup_root: Option<String>,
    moved_paths: Vec<MigrationMove>,
    conflicts: Vec<String>,
    status: &str,
) -> CognitionNamespaceMigrationManifest {
    CognitionNamespaceMigrationManifest {
        schema: SCHEMA,
        migration_id: format!("namespace-v1-{}", now_millis()),
        started_at,
        completed_at: iso(completed_ms),
        legacy_memory_root: plan.legacy_memory_root.clone(),
        cognition_root: plan.cognition_root.clone(),
        cognition_memory_root: plan.cognition_memory_root.clone(),
        backup_root,
        moved_paths,
        conflicts,
        status: status.to_owned(),
        raw_text_included: false,
    }
}

fn file_stats(data_root: &Path, root: &Path) -> CognitionResult<FileStats> {
    let mut stats = FileStats::default();
    let mut visited = HashSet::new();
    visit(data_root, root, &mut visited, &mut stats)?;
    Ok(stats)
}

fn visit(
    data_root: &Path,
    path: &Path,
    visited: &mut HashSet<PathBuf>,
    stats: &mut FileStats,
) -> CognitionResult<()> {
    mutable_paths::ensure_data_authority(data_root, &[path])?;
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(failure("cognition_migration_read_failed")),
    };
    if metadata.is_dir() {
        let canonical =
            fs::canonicalize(path).map_err(|_| failure("cognition_migration_read_failed"))?;
        if !visited.insert(canonical) {
            return Ok(());
        }
        for entry in fs::read_dir(path).map_err(|_| failure("cognition_migration_read_failed"))? {
            let entry = entry.map_err(|_| failure("cognition_migration_read_failed"))?;
            if entry.file_name() == ".DS_Store" {
                continue;
            }
            visit(data_root, &entry.path(), visited, stats)?;
        }
    } else if metadata.is_file() {
        stats.files += 1;
        stats.bytes = stats.bytes.saturating_add(metadata.len());
    }
    Ok(())
}

fn read_manifest_status(path: &Path) -> Option<&'static str> {
    let raw = fs::read(path).ok()?;
    let value: Value = serde_json::from_slice(&raw).ok()?;
    if value.get("schema")?.as_str()? != SCHEMA {
        return None;
    }
    match value.get("status")?.as_str()? {
        "applied" => Some("applied"),
        _ => None,
    }
}

fn write_manifest(
    data_root: &Path,
    path: &Path,
    manifest: &CognitionNamespaceMigrationManifest,
) -> CognitionResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| failure("cognition_migration_write_failed"))?;
    mutable_paths::ensure_data_authority(data_root, &[parent, path])?;
    create_private_dir(parent)?;
    let mut bytes = serde_json::to_vec_pretty(manifest)
        .map_err(|_| failure("cognition_migration_write_failed"))?;
    bytes.push(b'\n');
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| failure("cognition_migration_write_failed"))?;
    file.write_all(&bytes)
        .and_then(|()| file.sync_all())
        .map_err(|_| failure("cognition_migration_write_failed"))
}

fn move_directory(data_root: &Path, from: &Path, to: &Path) -> CognitionResult<()> {
    let parent = to
        .parent()
        .ok_or_else(|| failure("cognition_migration_move_failed"))?;
    mutable_paths::ensure_data_authority(data_root, &[from, parent, to])?;
    create_private_dir(parent)?;
    if to.try_exists().unwrap_or(false) && file_stats(data_root, to)?.files == 0 {
        remove_path(to).map_err(|_| failure("cognition_migration_move_failed"))?;
    }
    match fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::CrossesDevices => {
            copy_tree(data_root, from, to)?;
            remove_path(from).map_err(|_| failure("cognition_migration_move_failed"))
        }
        Err(_) => Err(failure("cognition_migration_move_failed")),
    }
}

fn copy_tree(data_root: &Path, from: &Path, to: &Path) -> CognitionResult<()> {
    mutable_paths::ensure_data_authority(data_root, &[from, to])?;
    let metadata = fs::metadata(from).map_err(|_| failure("cognition_migration_backup_failed"))?;
    if metadata.is_dir() {
        create_private_dir(to)?;
        for entry in fs::read_dir(from).map_err(|_| failure("cognition_migration_backup_failed"))? {
            let entry = entry.map_err(|_| failure("cognition_migration_backup_failed"))?;
            copy_tree(data_root, &entry.path(), &to.join(entry.file_name()))?;
        }
    } else if metadata.is_file() {
        if let Some(parent) = to.parent() {
            create_private_dir(parent)?;
        }
        fs::copy(from, to).map_err(|_| failure("cognition_migration_backup_failed"))?;
    }
    Ok(())
}

fn remove_path(path: &Path) -> Result<(), std::io::Error> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || metadata.is_file() {
        fs::remove_file(path)
    } else {
        fs::remove_dir_all(path)
    }
}

fn create_private_dir(path: &Path) -> CognitionResult<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(path)
        .or_else(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists && path.is_dir() {
                Ok(())
            } else {
                Err(error)
            }
        })
        .map_err(|_| failure("cognition_migration_write_failed"))
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn iso(value: i64) -> String {
    crate::js_date::format_iso_millis(value)
        .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_owned())
}
