//! Source-shaped command-scoped import planning and marker ownership.

use std::{fs, io::Write, path::PathBuf};

use serde_json::Value;

use super::{
    CognitionError, CognitionPathEnvironment, CognitionResult, ensure_data_authority,
    legacy_hot_prefix, prepare_legacy_transcript,
};

pub(crate) struct LegacyMemoryImportService {
    data_root: PathBuf,
    paths: CognitionPathEnvironment,
}

pub(crate) struct LegacyMemoryImportPlan {
    pub format: String,
    pub session_id: String,
    pub project: String,
    path_hint: String,
    pub transcript_path: PathBuf,
    pub message_count: usize,
    pub chunks: Vec<LegacyMemoryImportChunk>,
}

pub(crate) struct LegacyMemoryImportChunk {
    pub chunk_id: String,
    pub conversation_text: String,
    pub hot_text: String,
}

impl LegacyMemoryImportService {
    pub(crate) fn new(data_root: PathBuf, paths: CognitionPathEnvironment) -> Self {
        Self { data_root, paths }
    }

    pub(crate) fn plan(
        &self,
        requested_session_id: &str,
    ) -> CognitionResult<LegacyMemoryImportPlan> {
        let file_name = transcript_file_name(requested_session_id);
        let transcript_root = self.data_root.join("transcripts");
        let transcript_path = transcript_root.join(format!("{file_name}.jsonl"));
        ensure_data_authority(&self.data_root, &[&transcript_root, &transcript_path])?;
        let raw = fs::read(&transcript_path).map_err(|failure| {
            if failure.kind() == std::io::ErrorKind::NotFound {
                CognitionError::new(
                    "not_found",
                    format!("transcript not found for session: {requested_session_id}"),
                )
            } else {
                error("memory_transcript_read_failed")
            }
        })?;
        let content = String::from_utf8_lossy(&raw);
        let lines = content
            .split('\n')
            .filter(|line| !crate::public_text::trim_js_whitespace(line).is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let source_session_id = transcript_session_id(&lines);
        let format = if source_session_id.is_some() {
            "butler-transcript"
        } else {
            "unknown"
        };
        let session_id = source_session_id.unwrap_or_else(|| file_session_id(&transcript_path));
        let path_hint = transcript_path
            .parent()
            .and_then(|path| path.file_name())
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let (message_count, parsed_chunks) = prepare_legacy_transcript(&lines, &session_id);
        let chunks = parsed_chunks
            .into_iter()
            .enumerate()
            .map(|(index, chunk)| {
                let truncated = legacy_hot_prefix(&chunk.conversation_text);
                let hot_text = if chunk.conversation_text.encode_utf16().count() > 8_000 {
                    format!("{truncated}\n...(truncated)")
                } else {
                    truncated
                };
                LegacyMemoryImportChunk {
                    chunk_id: format!("{session_id}_chunk{index}"),
                    conversation_text: chunk.conversation_text,
                    hot_text,
                }
            })
            .collect();
        Ok(LegacyMemoryImportPlan {
            format: format.to_owned(),
            session_id,
            project: String::new(),
            path_hint,
            transcript_path,
            message_count,
            chunks,
        })
    }

    pub(crate) fn resolve_project(
        &self,
        plan: &mut LegacyMemoryImportPlan,
        project_id: Option<&str>,
    ) -> CognitionResult<()> {
        if plan.format == "butler-transcript"
            && let Some(project_id) = project_id
            && !crate::public_text::trim_js_whitespace(project_id).is_empty()
        {
            plan.project = project_id.to_owned();
            return Ok(());
        }
        plan.project = resolve_import_project(&self.data_root, &plan.path_hint)?;
        Ok(())
    }

    pub(crate) fn already_imported(&self, session_id: &str) -> CognitionResult<bool> {
        let path = self.imported_marker_path();
        ensure_data_authority(&self.data_root, &[&path])?;
        let content = match fs::read(&path) {
            Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Err(failure) if failure.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(_) => return Err(error("memory_import_marker_read_failed")),
        };
        Ok(content
            .lines()
            .any(|line| crate::public_text::trim_js_whitespace(line) == session_id))
    }

    pub(crate) fn prepare_apply(&self) -> CognitionResult<()> {
        let memory_root = self.paths.memory_root(&self.data_root);
        let db_root = memory_root.join("db");
        ensure_data_authority(&self.data_root, &[&memory_root, &db_root])?;
        fs::create_dir_all(&db_root).map_err(|_| error("memory_import_marker_write_failed"))
    }

    pub(crate) fn mark_imported(&self, session_id: &str) -> CognitionResult<()> {
        let path = self.imported_marker_path();
        let parent = path
            .parent()
            .ok_or_else(|| error("memory_import_marker_write_failed"))?;
        ensure_data_authority(&self.data_root, &[parent, &path])?;
        fs::create_dir_all(parent).map_err(|_| error("memory_import_marker_write_failed"))?;
        let mut options = fs::OpenOptions::new();
        options.append(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(path)
            .map_err(|_| error("memory_import_marker_write_failed"))?;
        writeln!(file, "{session_id}").map_err(|_| error("memory_import_marker_write_failed"))
    }

    fn imported_marker_path(&self) -> PathBuf {
        self.paths
            .memory_root(&self.data_root)
            .join("db/imported-sessions.txt")
    }
}

fn transcript_session_id(lines: &[String]) -> Option<String> {
    lines.iter().find_map(|line| {
        let value = serde_json::from_str::<Value>(line).ok()?;
        let object = value.as_object()?;
        object.get("eventId")?.as_str()?;
        let session_id = object.get("sessionId")?.as_str()?;
        object.get("kind")?.as_str()?;
        object.get("timestamp")?.as_str()?;
        let payload = object.get("payload")?;
        (payload.is_object() || payload.is_array()).then(|| session_id.to_owned())
    })
}

fn transcript_file_name(session_id: &str) -> String {
    session_id
        .encode_utf16()
        .map(|unit| {
            let Some(character) = char::from_u32(u32::from(unit)) else {
                return '_';
            };
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn file_session_id(path: &std::path::Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .strip_suffix(".jsonl")
        .unwrap_or_default()
        .to_owned()
}

fn resolve_import_project(data_root: &std::path::Path, path_hint: &str) -> CognitionResult<String> {
    if let Some(project) = resolve_project_key(data_root, path_hint)? {
        return Ok(project);
    }
    if !path_hint.is_empty() && !path_hint.starts_with('-') {
        return Ok(path_hint.to_owned());
    }
    Ok(resolve_project_key(data_root, "butler")?.unwrap_or_else(|| "butler".to_owned()))
}

fn resolve_project_key(data_root: &std::path::Path, raw: &str) -> CognitionResult<Option<String>> {
    let raw = crate::public_text::trim_js_whitespace(raw);
    if raw.is_empty() {
        return Ok(None);
    }
    let config_path = data_root.join("butler.config.json");
    ensure_data_authority(data_root, &[&config_path])?;
    let config = match fs::read(&config_path) {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes).ok(),
        Err(failure) if failure.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err(error("memory_project_registry_read_failed")),
    };
    let projects = match config.as_ref().and_then(|value| value.get("projects")) {
        Some(Value::Array(projects)) => projects.iter().collect::<Vec<_>>(),
        Some(Value::Object(projects)) => projects.values().collect::<Vec<_>>(),
        _ => Vec::new(),
    };
    for project in &projects {
        if project.get("name").and_then(Value::as_str) == Some(raw) {
            return Ok(Some(raw.to_owned()));
        }
    }
    if raw.starts_with('/') {
        for project in &projects {
            let Some(name) = project.get("name").and_then(Value::as_str) else {
                continue;
            };
            if let Some(path) = project.get("path").and_then(Value::as_str)
                && expand_home_path(path).to_string_lossy() == raw
            {
                return Ok(Some(name.to_owned()));
            }
        }
    }
    for project in projects {
        let Some(name) = project.get("name").and_then(Value::as_str) else {
            continue;
        };
        let Some(path) = project.get("path").and_then(Value::as_str) else {
            continue;
        };
        if encode_project_path_key(&expand_home_path(path)) == raw {
            return Ok(Some(name.to_owned()));
        }
    }
    Ok(None)
}

fn expand_home_path(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix('~') {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_default();
        home.join(rest.trim_start_matches(['/', '\\']))
    } else {
        PathBuf::from(path)
    }
}

fn encode_project_path_key(path: &std::path::Path) -> String {
    path.to_string_lossy()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect()
}

fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
