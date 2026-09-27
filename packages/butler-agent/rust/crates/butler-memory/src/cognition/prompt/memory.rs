use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::cognition::{
    CognitionError, CognitionPathEnvironment, CognitionResult,
    generation::{HotCacheEntryView, physical_hot_cache_entries},
    graph::GraphRepository,
    resolve_active_generation,
};
use butler_turn::conversation::{ConversationSourceReader, conversation_store_path};

use super::CapsulePresence;
use crate::cognition::CognitionCode;

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
    // Hex of the first 16 digest bytes.
    let mut key = format!("{:x}", Sha256::digest(session.as_bytes()));
    key.truncate(32);
    optional_text(&memory_root.join("sessions").join(format!("{key}.md")))
}

pub(super) fn capsule_path(memory_root: &Path, project: Option<&str>) -> Option<PathBuf> {
    let project = butler_core::public_text::trim_js_whitespace(project?);
    if project.is_empty() {
        return None;
    }
    let mut safe = String::with_capacity(project.len());
    for character in project.chars() {
        if matches!(character, '/' | '\\' | '\0') {
            safe.push('_');
        } else {
            safe.push(character);
        }
    }
    Some(memory_root.join("projects").join(format!("{safe}.md")))
}

pub(super) fn project(
    memory_root: &Path,
    project: Option<&str>,
) -> CognitionResult<Option<String>> {
    let Some(path) = capsule_path(memory_root, project) else {
        return Ok(None);
    };
    let Some(text) = optional_text(&path)? else {
        return Ok(None);
    };
    let filtered = text
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .filter(|line| {
            !line.contains("generation-hot-cache:") && !line.contains("project-hot-cache:")
        })
        .collect::<Vec<_>>()
        .join("\n");
    let filtered = butler_core::public_text::trim_js_whitespace(&filtered);
    Ok((!filtered.is_empty()).then(|| filtered.to_owned()))
}

pub(super) fn status(
    memory_root: &Path,
    project: Option<&str>,
) -> CognitionResult<CapsulePresence> {
    let Some(path) = capsule_path(memory_root, project) else {
        return Ok(CapsulePresence::Skipped);
    };
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
) -> CognitionResult<Option<String>> {
    // Source's optional prompt projection treats an unavailable or changing
    // generation as absent. Keep this read path separate from mutation authority.
    Ok(read_generation_hot_cache(data_root, environment, project).unwrap_or(None))
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
    let Some(cache) = optional_text(&path)? else {
        return Ok(None);
    };
    let entries = physical_hot_cache_entries(&cache);
    if entries.is_empty() {
        return Ok(None);
    }
    let graph = GraphRepository::open_readonly(&generation.graph_path)?;
    let Ok(canonical) = ConversationSourceReader::open(&conversation_store_path(data_root)) else {
        graph.close()?;
        return Ok(None);
    };
    let result = project_entries(
        data_root,
        environment,
        project,
        &generation,
        &graph,
        &canonical,
        &entries,
    );
    let canonical_closed = canonical.close().map_err(CognitionError::from);
    let graph_closed = graph.close();
    canonical_closed?;
    graph_closed?;
    result
}

fn project_entries(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    project: Option<&str>,
    generation: &crate::cognition::MemoryGenerationHandle,
    graph: &GraphRepository,
    canonical: &ConversationSourceReader,
    entries: &[HotCacheEntryView],
) -> CognitionResult<Option<String>> {
    let Some(before_revision) = graph.hot_cache_graph_revision()? else {
        return Ok(None);
    };
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
    for entry in selected {
        if !entry
            .entry_id
            .as_deref()
            .is_some_and(|id| valid.contains(id))
        {
            continue;
        }
        let Some(refs) = &entry.source_refs else {
            continue;
        };
        let class = graph.hot_cache_source_class(refs)?;
        let Some(summary) = &entry.summary else {
            continue;
        };
        content.push(format!(
            "[model_interpretation/{class}; current_state_requires_verification]\n{summary}"
        ));
    }
    if graph.hot_cache_graph_revision()? != Some(before_revision)
        || resolve_active_generation(data_root, environment)?.generation_id
            != generation.generation_id
    {
        return Ok(None);
    }
    Ok((!content.is_empty()).then(|| content.join("\n\n")))
}
