use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use super::catalog::{load, project_dir, safe_name, summary, user_dir};
use super::{SkillError, SkillImportResult, error};

pub(super) fn import(
    data: &Path,
    _name: &str,
    archive_path: &Path,
    project: Option<&str>,
) -> Result<SkillImportResult, SkillError> {
    let staging = data
        .join("skills/.imports")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&staging).map_err(io)?;
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
    let file = fs::File::open(archive_path).map_err(io)?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|source| error("skill_archive_invalid", &source.to_string()))?;
    for index in 0..archive.len() {
        let mut item = archive
            .by_index(index)
            .map_err(|source| error("skill_archive_invalid", &source.to_string()))?;
        let relative = item.enclosed_name().ok_or_else(|| {
            error(
                "skill_archive_path_invalid",
                "Skill archive contains an unsafe path",
            )
        })?;
        let output = staging.join(relative);
        if item.is_dir() {
            fs::create_dir_all(&output).map_err(io)?;
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(io)?;
        }
        let mut destination = fs::File::create(&output).map_err(io)?;
        std::io::copy(&mut item, &mut destination).map_err(io)?;
        destination.flush().map_err(io)?;
    }

    let candidates = find_skill_dirs(staging)?;
    let target = project.map_or_else(|| user_dir(data), |id| project_dir(data, id));
    fs::create_dir_all(&target).map_err(io)?;
    let mut imported = Vec::new();
    let mut skipped = Vec::new();
    for source in candidates {
        let name = source
            .file_name()
            .and_then(|value| value.to_str())
            .map(safe_name)
            .unwrap_or_default();
        if name.is_empty() {
            skipped.push(source.to_string_lossy().into_owned());
            continue;
        }
        let destination = target.join(&name);
        if destination.exists() {
            fs::remove_dir_all(&destination).map_err(io)?;
        }
        copy_tree(&source, &destination)?;
        if let Some(skill) = load(&target)?
            .into_iter()
            .find(|skill| skill.file_path.starts_with(&destination))
        {
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
    for entry in fs::read_dir(root).map_err(io)? {
        let entry = entry.map_err(io)?;
        if !entry.file_type().map_err(io)?.is_dir() {
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

fn copy_tree(source: &Path, target: &Path) -> Result<(), SkillError> {
    fs::create_dir_all(target).map_err(io)?;
    for entry in fs::read_dir(source).map_err(io)? {
        let entry = entry.map_err(io)?;
        let destination = target.join(entry.file_name());
        if entry.file_type().map_err(io)?.is_dir() {
            copy_tree(&entry.path(), &destination)?;
        } else {
            fs::copy(entry.path(), destination).map_err(io)?;
        }
    }
    Ok(())
}

#[expect(
    clippy::needless_pass_by_value,
    reason = "map_err/iterator adapter taking owned values"
)]
fn io(source: std::io::Error) -> SkillError {
    error("skills_io_failed", &source.to_string())
}
