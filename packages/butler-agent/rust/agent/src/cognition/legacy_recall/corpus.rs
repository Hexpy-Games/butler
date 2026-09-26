mod graph;

use std::{
    fs,
    path::{Path, PathBuf},
};

use crate::{
    cognition::{CognitionError, CognitionPathEnvironment, CognitionResult, ensure_data_authority},
    public_text::{is_js_whitespace, trim_js_whitespace},
};

use super::types::{
    LegacyRecallCandidate, LegacyRecallCorpus, LegacyRecallOriginalSource, LegacyRecallSource,
};

const FILE_CANDIDATE_SUMMARY_CHARS: usize = 420;

pub(super) fn load(
    data_root: &Path,
    paths: &CognitionPathEnvironment,
    project_id: Option<&str>,
) -> CognitionResult<LegacyRecallCorpus> {
    let memory_root = paths.memory_root(data_root);
    let project_id = project_id
        .map(trim_js_whitespace)
        .filter(|value| !value.is_empty());
    let mut corpus = LegacyRecallCorpus::default();
    for path in list_markdown_files(data_root, &memory_root.join("hot"))? {
        append_hot_file(data_root, &mut corpus, &path)?;
    }
    for path in list_markdown_files(data_root, &memory_root.join("hot/topics"))? {
        append_hot_file(data_root, &mut corpus, &path)?;
    }

    for path in list_markdown_files(data_root, &memory_root.join("tasks"))? {
        let text = read_text(data_root, &path)?;
        if trim_js_whitespace(&text).is_empty() {
            continue;
        }
        if project_id.is_some_and(|project| !text.to_lowercase().contains(&project.to_lowercase()))
        {
            continue;
        }
        corpus.candidates.push(file_candidate(
            &path,
            text,
            LegacyRecallSource::TaskMemory,
            LegacyRecallOriginalSource::TaskMemory,
            None,
        ));
    }

    let project_dir = memory_root.join("projects");
    let safe_project_id = project_id.map(sanitize_project_memory_id);
    for path in list_markdown_files(data_root, &project_dir)? {
        if safe_project_id.as_deref().is_some_and(|project| {
            path.file_name()
                .map(|value| value.to_string_lossy())
                .and_then(|name| name.strip_suffix(".md").map(str::to_owned))
                .as_deref()
                != Some(project)
        }) {
            continue;
        }
        let text = read_text(data_root, &path)?;
        if trim_js_whitespace(&text).is_empty() {
            continue;
        }
        corpus.candidates.push(file_candidate(
            &path,
            text,
            LegacyRecallSource::ProjectMemory,
            LegacyRecallOriginalSource::ProjectMemory,
            None,
        ));
    }

    for path in list_markdown_files(data_root, &memory_root.join("rules"))? {
        let text = read_text(data_root, &path)?;
        if trim_js_whitespace(&text).is_empty() {
            continue;
        }
        corpus.candidates.push(file_candidate(
            &path,
            text,
            LegacyRecallSource::Explicit,
            LegacyRecallOriginalSource::Rules,
            Some(1.0),
        ));
    }

    let graph = graph::load(data_root, &memory_root.join("db/graph.sqlite"), project_id)?;
    corpus.nodes = graph.nodes;
    corpus.edges = graph.edges;
    corpus.candidates.extend(graph.candidates);
    Ok(corpus)
}

fn list_markdown_files(data_root: &Path, directory: &Path) -> CognitionResult<Vec<PathBuf>> {
    ensure_data_authority(data_root, &[directory])?;
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let entries = fs::read_dir(directory).map_err(read_error)?;
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(read_error)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".md") {
            let path = directory.join(entry.file_name());
            ensure_data_authority(data_root, &[&path])?;
            files.push(path);
        }
    }
    Ok(files)
}

fn read_text(data_root: &Path, path: &Path) -> CognitionResult<String> {
    ensure_data_authority(data_root, &[path])?;
    Ok(fs::read(path)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default())
}

fn read_error(error: std::io::Error) -> CognitionError {
    CognitionError::new("legacy_recall_read_failed", error.to_string())
}

fn append_hot_file(
    data_root: &Path,
    corpus: &mut LegacyRecallCorpus,
    path: &Path,
) -> CognitionResult<()> {
    let text = read_text(data_root, path)?;
    if trim_js_whitespace(&text).is_empty() {
        return Ok(());
    }
    let blocks = markdown_memory_blocks(&text);
    for (index, block) in blocks.into_iter().enumerate() {
        corpus.candidates.push(file_candidate(
            &append_fragment(path, &format!("#block-{}", index + 1)),
            block,
            LegacyRecallSource::HotCache,
            LegacyRecallOriginalSource::HotCache,
            None,
        ));
    }
    Ok(())
}

fn markdown_memory_blocks(text: &str) -> Vec<String> {
    let normalized = text.replace("\r\n", "\n");
    let mut blocks = Vec::new();
    let mut current = Vec::new();
    for line in normalized.split('\n') {
        if is_markdown_heading(line)
            && current
                .iter()
                .any(|value: &String| !trim_js_whitespace(value).is_empty())
        {
            blocks.push(trim_js_whitespace(&current.join("\n")).to_owned());
            current.clear();
        }
        current.push(line.to_owned());
    }
    if current
        .iter()
        .any(|value| !trim_js_whitespace(value).is_empty())
    {
        blocks.push(trim_js_whitespace(&current.join("\n")).to_owned());
    }
    let usable = blocks
        .into_iter()
        .filter(|block| !trim_js_whitespace(block).is_empty())
        .collect::<Vec<_>>();
    if usable.len() > 1 {
        usable
    } else {
        let trimmed = trim_js_whitespace(text);
        if trimmed.is_empty() {
            Vec::new()
        } else {
            vec![trimmed.to_owned()]
        }
    }
}

fn is_markdown_heading(line: &str) -> bool {
    let hash_count = line.chars().take_while(|value| *value == '#').count();
    if !(1..=6).contains(&hash_count) {
        return false;
    }
    let mut rest = line.chars().skip(hash_count).peekable();
    if !rest.next().is_some_and(is_js_whitespace) {
        return false;
    }
    while rest.peek().is_some_and(|value| is_js_whitespace(*value)) {
        rest.next();
    }
    rest.next().is_some_and(|value| !is_js_whitespace(value))
}

fn file_candidate(
    path: &Path,
    text: String,
    source: LegacyRecallSource,
    original_source: LegacyRecallOriginalSource,
    explicit_salience: Option<f64>,
) -> LegacyRecallCandidate {
    let path = path.to_string_lossy().into_owned();
    LegacyRecallCandidate {
        id: format!("{}:{path}", source_prefix(source)),
        summary: compact(&text, FILE_CANDIDATE_SUMMARY_CHARS),
        text,
        source,
        original_source: Some(original_source),
        provenance: vec![path],
        related_nodes: Vec::new(),
        timestamp: None,
        frequency: None,
        explicit_salience,
        vector_similarity: None,
        contextual_score: None,
        superseded_by: None,
        contradicts: Vec::new(),
    }
}

fn source_prefix(source: LegacyRecallSource) -> &'static str {
    match source {
        LegacyRecallSource::HotCache => "hot",
        LegacyRecallSource::Vector => "vector",
        LegacyRecallSource::Graph => "graph",
        LegacyRecallSource::Explicit => "rule",
        LegacyRecallSource::Hybrid => "hybrid",
        LegacyRecallSource::ProjectMemory => "project",
        LegacyRecallSource::TaskMemory => "task",
    }
}

fn append_fragment(path: &Path, fragment: &str) -> PathBuf {
    PathBuf::from(format!("{}{fragment}", path.to_string_lossy()))
}

fn sanitize_project_memory_id(project_id: &str) -> String {
    project_id
        .chars()
        .map(|value| {
            if matches!(value, '/' | '\\' | '\0') {
                '_'
            } else {
                value
            }
        })
        .collect()
}

fn compact(value: &str, limit: usize) -> String {
    let mut normalized = String::with_capacity(value.len());
    let mut pending_space = false;
    for character in value.chars() {
        if is_js_whitespace(character) {
            pending_space = !normalized.is_empty();
        } else {
            if pending_space {
                normalized.push(' ');
            }
            normalized.push(character);
            pending_space = false;
        }
    }
    let normalized = trim_js_whitespace(&normalized);
    let prefix = slice_utf16(normalized, limit);
    if normalized.encode_utf16().count() > limit {
        format!("{prefix}...")
    } else {
        normalized.to_owned()
    }
}

fn slice_utf16(value: &str, limit: usize) -> String {
    let mut output = String::with_capacity(value.len().min(limit));
    let mut units = 0;
    for character in value.chars() {
        let character_units = character.len_utf16();
        if units + character_units > limit {
            if character_units == 2 && units < limit {
                output.push('\u{fffd}');
            }
            break;
        }
        output.push(character);
        units += character_units;
    }
    output
}
