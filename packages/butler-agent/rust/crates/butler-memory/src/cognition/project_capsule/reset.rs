//! Project reset stops autonomous refresh until a new project conversation has a projection.
use super::*;
use rusqlite::OpenFlags;
use std::path::Path;
pub(super) fn was_reset(
    root: &Path,
    paths: &CognitionPathEnvironment,
    project: &str,
) -> CognitionResult<bool> {
    Ok(epoch(root, paths, project)?.is_some())
}
pub(super) fn epoch(
    root: &Path,
    paths: &CognitionPathEnvironment,
    project: &str,
) -> CognitionResult<Option<String>> {
    use rusqlite::OptionalExtension;
    let Some(db) = database(root, paths)? else {
        return Ok(None);
    };
    let present: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='memory_project_resets')",
            [],
            |row| row.get(0),
        )
        .map_err(failed)?;
    if !present {
        return Ok(None);
    }
    db.query_row(
        "SELECT epoch FROM memory_project_resets WHERE project_id=?1",
        [project],
        |row| row.get(0),
    )
    .optional()
    .map_err(failed)
}

pub(super) fn may_refresh(
    root: &Path,
    paths: &CognitionPathEnvironment,
    project: &str,
) -> CognitionResult<bool> {
    if !was_reset(root, paths, project)? {
        return Ok(true);
    }
    let Some(db) = database(root, paths)? else {
        return Ok(false);
    };
    db.query_row("SELECT EXISTS(SELECT 1 FROM memory_chunks c JOIN memory_chunk_sources s ON s.episode_id=c.memory_chunk_id WHERE c.project_id=?1 AND c.status='active' AND s.source_kind='conversation' AND s.revision=c.current_revision)", [project], |row| row.get(0)).map_err(failed)
}
fn database(
    root: &Path,
    paths: &CognitionPathEnvironment,
) -> CognitionResult<Option<rusqlite::Connection>> {
    if !crate::cognition::active_memory_descriptor_exists(root, paths)? {
        return Ok(None);
    }
    let active = crate::cognition::resolve_active_generation(root, paths)?;
    butler_platform::sqlite::open_with_flags(active.graph_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map(Some)
        .map_err(failed)
}
fn failed(source: rusqlite::Error) -> CognitionError {
    error(CognitionCode::ProjectCapsuleSourceReadFailed).with_source(source)
}
