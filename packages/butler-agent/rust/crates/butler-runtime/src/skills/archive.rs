use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use super::catalog::{project_dir, safe_name, summary, user_dir};
use super::{SkillError, SkillImportResult};

pub(super) fn import(
    data: &Path,
    _name: &str,
    archive_path: &Path,
    project: Option<&str>,
) -> Result<SkillImportResult, SkillError> {
    let staging = data
        .join("skills/.imports")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&staging).map_err(SkillError::Io)?;
    let result = extract_and_install(data, archive_path, project, &staging);
    let _ = fs::remove_dir_all(&staging);
    result
}

fn extract_and_install(
    data: &Path,
    archive_path: &Path,
    project: Option<&str>,
    staging: &Path,
) -> Result<SkillImportResult, SkillError> {
    let file = fs::File::open(archive_path).map_err(SkillError::Io)?;
    let mut archive = zip::ZipArchive::new(file).map_err(SkillError::ArchiveInvalid)?;
    for index in 0..archive.len() {
        let mut item = archive
            .by_index(index)
            .map_err(SkillError::ArchiveInvalid)?;
        let relative = item.enclosed_name().ok_or(SkillError::ArchivePathInvalid)?;
        let output = staging.join(relative);
        if item.is_dir() {
            fs::create_dir_all(&output).map_err(SkillError::Io)?;
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(SkillError::Io)?;
        }
        let mut destination = fs::File::create(&output).map_err(SkillError::Io)?;
        std::io::copy(&mut item, &mut destination).map_err(SkillError::Io)?;
        destination.flush().map_err(SkillError::Io)?;
    }

    let candidates = find_skill_dirs(staging)?;
    let target = project.map_or_else(|| user_dir(data), |id| project_dir(data, id));
    fs::create_dir_all(&target).map_err(SkillError::Io)?;
    let mut imported = Vec::new();
    let mut skipped = Vec::new();
    for source in candidates {
        let name = source
            .file_name()
            .and_then(|value| value.to_str())
            .map(safe_name)
            .unwrap_or_default();
        if name.is_empty() || name.starts_with('.') {
            skipped.push(source.to_string_lossy().into_owned());
            continue;
        }
        if let Some(skill) = super::install::replace(&source, &target, &name)? {
            imported.push(summary(
                skill,
                if project.is_some() { "project" } else { "user" },
                project,
            ));
        }
    }
    Ok(SkillImportResult { imported, skipped })
}

fn find_skill_dirs(root: &Path) -> Result<Vec<PathBuf>, SkillError> {
    let mut found = Vec::new();
    for entry in fs::read_dir(root).map_err(SkillError::Io)? {
        let entry = entry.map_err(SkillError::Io)?;
        if !entry.file_type().map_err(SkillError::Io)?.is_dir() {
            continue;
        }
        let path = entry.path();
        if path.join("SKILL.md").is_file() {
            found.push(path);
        } else {
            found.extend(find_skill_dirs(&path)?);
        }
    }
    Ok(found)
}

pub(super) fn copy_tree(source: &Path, target: &Path) -> Result<(), SkillError> {
    fs::create_dir_all(target).map_err(SkillError::Io)?;
    for entry in fs::read_dir(source).map_err(SkillError::Io)? {
        let entry = entry.map_err(SkillError::Io)?;
        let destination = target.join(entry.file_name());
        if entry.file_type().map_err(SkillError::Io)?.is_dir() {
            copy_tree(&entry.path(), &destination)?;
        } else {
            fs::copy(entry.path(), destination).map_err(SkillError::Io)?;
            butler_platform::secure_fs::fault_checkpoint("skill_copy").map_err(SkillError::Io)?;
        }
    }
    Ok(())
}
