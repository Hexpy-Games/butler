//! Hot-cache, continuity and project page text for prompts.

use std::fs;
use std::path::Path;

use crate::cognition::{
    CognitionError, CognitionPathEnvironment, CognitionResult,
    generation::{HotCacheEntryView, RECENT_TEXT_BYTES, physical_hot_cache_entries},
    graph::GraphRepository,
    resolve_active_generation, standing,
};
use butler_turn::conversation::{ConversationSourceReader, conversation_store_path};

use super::CapsulePresence;
use crate::cognition::CognitionCode;

const RECENT_HEADER: &str = "What the user said in recent chats, newest first. These are their statements as Butler remembered them; recall_memory returns the full exchange.";

fn failure(error: &std::io::Error) -> CognitionError {
    CognitionError::new(CognitionCode::CognitionPromptReadFailed, error.to_string())
}

fn optional_text(path: &Path) -> CognitionResult<Option<String>> {
    let text = match super::read_utf8(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(failure(&error)),
    };
    let text = butler_core::public_text::trim_js_whitespace(&text);
    Ok((!text.is_empty()).then(|| text.to_owned()))
}

pub(super) fn continuity(memory_root: &Path, session: &str) -> CognitionResult<Option<String>> {
    let summary =
        crate::cognition::continuity::read(memory_root, session).map_err(|e| failure(&e))?;
    let text = summary.text.trim();
    Ok((!text.is_empty()).then(|| format!("{}\n\n{text}", crate::cognition::continuity::HEADER)))
}

/// The project's page in the active generation; absent when there is no
/// page, no project, or the generation is unavailable or changing.
pub(super) fn project_page(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    project: Option<&str>,
) -> Option<String> {
    read_project_page(data_root, environment, project).unwrap_or(None)
}

fn read_project_page(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    project: Option<&str>,
) -> CognitionResult<Option<String>> {
    let Some(project) = project
        .map(butler_core::public_text::trim_js_whitespace)
        .filter(|project| !project.is_empty())
    else {
        return Ok(None);
    };
    if !environment
        .memory_root(data_root)
        .join("active-generation.json")
        .exists()
    {
        return Ok(None);
    }
    let generation = resolve_active_generation(data_root, environment)?;
    let graph = GraphRepository::open_read_snapshot(&generation.graph_path)?;
    let page = standing::current(
        &graph,
        &generation.root,
        &standing::Page::Project(project.to_owned()),
    );
    graph.close()?;
    page
}

/// Whether the project has a page file in the active generation.
pub(super) fn project_page_status(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    project: Option<&str>,
) -> CognitionResult<CapsulePresence> {
    let Some(project) = project
        .map(butler_core::public_text::trim_js_whitespace)
        .filter(|project| !project.is_empty())
    else {
        return Ok(CapsulePresence::Skipped);
    };
    if !environment
        .memory_root(data_root)
        .join("active-generation.json")
        .exists()
    {
        return Ok(CapsulePresence::Missing);
    }
    let generation = resolve_active_generation(data_root, environment)?;
    let path = standing::Page::Project(project.to_owned()).path(&generation.root);
    match fs::metadata(path) {
        Ok(_) => Ok(CapsulePresence::Present),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(CapsulePresence::Missing),
        Err(error) => Err(failure(&error)),
    }
}

pub(super) fn generation_hot_cache(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    project: Option<&str>,
) -> Option<String> {
    // Source's optional prompt projection treats an unavailable or changing
    // generation as absent. Keep this read path separate from mutation authority.
    read_generation_hot_cache(data_root, environment, project).unwrap_or(None)
}

fn read_generation_hot_cache(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    project: Option<&str>,
) -> CognitionResult<Option<String>> {
    let memory_root = environment.memory_root(data_root);
    if !memory_root.join("active-generation.json").exists() {
        return Ok(None);
    }
    let generation = resolve_active_generation(data_root, environment)?;
    let path = generation.root.join("hot/cache.md");
    let cache = optional_text(&path)?.unwrap_or_default();
    let entries = physical_hot_cache_entries(&cache);
    // Both parts use one fresh graph snapshot while background writes advance.
    let graph = GraphRepository::open_read_snapshot(&generation.graph_path)?;
    let mut content = Vec::new();
    if let Some(sheet) = standing::current(&graph, &generation.root, &standing::Page::User)
        .ok()
        .flatten()
    {
        content.push(sheet);
    }
    let recent = if !entries.is_empty()
        && let Ok(canonical) = ConversationSourceReader::open(&conversation_store_path(data_root))
    {
        let result = project_entries(project, &generation, &graph, &canonical, &entries);
        canonical.close().map_err(CognitionError::from).and(result)
    } else {
        Ok(None)
    };
    graph.close()?;
    if let Some(recent) = recent? {
        content.push(format!("{RECENT_HEADER}\n{recent}"));
    }
    if resolve_active_generation(data_root, environment)?.generation_id != generation.generation_id
    {
        return Ok(None);
    }
    Ok((!content.is_empty()).then(|| content.join("\n\n")))
}

fn project_entries(
    project: Option<&str>,
    generation: &crate::cognition::MemoryGenerationHandle,
    graph: &GraphRepository,
    canonical: &ConversationSourceReader,
    entries: &[HotCacheEntryView],
) -> CognitionResult<Option<String>> {
    if graph.hot_cache_graph_revision()?.is_none() {
        return Ok(None);
    }
    let project = project.map(butler_core::public_text::trim_js_whitespace);
    let now = chrono::Utc::now().to_rfc3339();
    let selected = entries
        .iter()
        .filter(|entry| {
            entry.scope.as_deref() != Some("project") || entry.project_id.as_deref() == project
        })
        .cloned()
        .collect::<Vec<_>>();
    let valid = graph.valid_rebuild_cache_entries(
        &generation.generation_id,
        &selected,
        &generation.source_root,
        canonical,
        &now,
    )?;
    let mut content = Vec::new();
    let mut bytes = 0;
    for entry in selected {
        if !entry
            .entry_id
            .as_deref()
            .is_some_and(|id| valid.contains(id))
        {
            continue;
        }
        let Some(source_time) = &entry.source_time else {
            continue;
        };
        let date: String = source_time.chars().take(10).collect();
        let Some(summary) = &entry.summary else {
            continue;
        };
        if bytes + summary.len() > RECENT_TEXT_BYTES {
            continue;
        }
        bytes += summary.len();
        content.push(format!("[{date}]\n{summary}"));
    }
    Ok((!content.is_empty()).then(|| content.join("\n\n")))
}
