//! Legacy no-generation transcript ingress state. Offsets remain the source authority.

mod parser;
mod query;
mod session_id;

use crate::cognition::{CognitionCode, CognitionError, CognitionResult, ensure_data_authority};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
};

pub(crate) use parser::ParsedChunk as LegacyTranscriptChunk;
pub use session_id::normalize_session_id_for_storage;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacySessionOffset {
    pub(crate) session_id: String,
    pub(crate) last_line: usize,
    pub(crate) byte_offset: usize,
}

/// How far each legacy session transcript has been indexed.
#[derive(Default)]
pub struct LegacySessionOffsets {
    values: BTreeMap<String, LegacySessionOffset>,
}

impl LegacySessionOffsets {
    /// The stored offsets.
    pub fn load(data_root: &Path, memory_root: &Path) -> CognitionResult<Self> {
        let path = offset_path(memory_root);
        ensure_data_authority(data_root, &[memory_root, &path])?;
        let raw = match fs::read_to_string(&path) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self::default());
            }
            Err(_) => return Err(failure(CognitionCode::LegacySessionOffsetReadFailed)),
        };
        let Ok(mut value) = serde_json::from_str::<Value>(&raw) else {
            return Ok(Self::default());
        };
        if value.get("sessionId").and_then(Value::as_str).is_some()
            && value.get("lastLine").and_then(Value::as_f64).is_some()
        {
            value = json!({"butler": value});
        }
        let mut values = BTreeMap::new();
        if let Some(entries) = value.as_object() {
            for (key, item) in entries {
                let Some(session_id) = item.get("sessionId").and_then(Value::as_str) else {
                    continue;
                };
                let Some(last_line) = item.get("lastLine").and_then(Value::as_u64) else {
                    continue;
                };
                values.insert(
                    key.clone(),
                    LegacySessionOffset {
                        session_id: session_id.to_owned(),
                        last_line: usize::try_from(last_line).unwrap_or(usize::MAX),
                        byte_offset: usize::try_from(
                            item.get("byteOffset").and_then(Value::as_u64).unwrap_or(0),
                        )
                        .unwrap_or(usize::MAX),
                    },
                );
            }
        }
        Ok(Self { values })
    }

    /// The offset of the session with `key`.
    pub fn get(&self, key: &str) -> Option<&LegacySessionOffset> {
        self.values.get(key)
    }
    /// Sets the offset of a session.
    pub fn insert(&mut self, key: String, value: LegacySessionOffset) {
        self.values.insert(key, value);
    }

    /// Stores the offsets.
    pub fn save(&self, data_root: &Path, memory_root: &Path) -> CognitionResult<()> {
        let path = offset_path(memory_root);
        let parent = path
            .parent()
            .ok_or_else(|| failure(CognitionCode::LegacySessionOffsetWriteFailed))?;
        ensure_data_authority(data_root, &[memory_root, parent, &path])?;
        butler_platform::secure_fs::create_private_dir_all(parent).map_err(|source| {
            failure(CognitionCode::LegacySessionOffsetWriteFailed).with_source(source)
        })?;
        let content = serde_json::to_vec_pretty(&self.values).map_err(|source| {
            failure(CognitionCode::LegacySessionOffsetWriteFailed).with_source(source)
        })?;
        butler_platform::secure_fs::replace_private(
            &path,
            |file| file.write_all(&content),
            std::convert::identity,
        )
        .map_err(|source| {
            failure(CognitionCode::LegacySessionOffsetWriteFailed).with_source(source)
        })
    }
}

/// The transcript lines after the session's stored offset, and the new offset.
pub fn read_legacy_new_lines(
    data_root: &Path,
    path: &Path,
    session_id: &str,
    prior: Option<&LegacySessionOffset>,
) -> CognitionResult<(Vec<String>, LegacySessionOffset)> {
    ensure_data_authority(data_root, &[path])?;
    let file = match fs::File::open(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((
                vec![],
                LegacySessionOffset {
                    session_id: session_id.into(),
                    last_line: prior.map_or(0, |value| value.last_line),
                    byte_offset: prior.map_or(0, |value| value.byte_offset),
                },
            ));
        }
        Err(_) => return Err(failure(CognitionCode::LegacyTranscriptReadFailed)),
    };
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    let mut count = 0usize;
    let mut bytes = 0usize;
    let mut lines = Vec::new();
    loop {
        line.clear();
        let read = reader.read_until(b'\n', &mut line).map_err(|source| {
            failure(CognitionCode::LegacyTranscriptReadFailed).with_source(source)
        })?;
        if read == 0 {
            break;
        }
        bytes += read;
        let text = String::from_utf8_lossy(&line);
        if !butler_core::public_text::trim_js_whitespace(&text).is_empty() {
            if count >= prior.map_or(0, |value| value.last_line) {
                lines.push(text.trim_end_matches(['\r', '\n']).to_owned());
            }
            count += 1;
        }
    }
    Ok((
        lines,
        LegacySessionOffset {
            session_id: session_id.into(),
            last_line: count,
            byte_offset: bytes,
        },
    ))
}

/// Parses transcript lines into indexing chunks; the message count and the chunks.
pub fn prepare_legacy_transcript(
    lines: &[String],
    fallback: &str,
) -> (usize, Vec<LegacyTranscriptChunk>) {
    let parsed = parser::parse_and_chunk(lines, fallback);
    (parsed.message_count, parsed.chunks)
}

/// The first 8000 UTF-16 units of `text`, as the hot cache stores it.
pub fn legacy_hot_prefix(text: &str) -> String {
    parser::prefix_utf16_8000(text)
}

/// Indexes transcript lines for exact queries; the rows written.
pub fn index_legacy_transcript_query(
    data_root: &Path,
    transcript_file: &Path,
    lines: &[String],
) -> CognitionResult<usize> {
    query::index(data_root, transcript_file, lines)
}

/// Records a session that could not be synced in the dead-letter queue.
pub fn append_legacy_session_diagnostic(
    data_root: &Path,
    memory_root: &Path,
    session_id: &str,
    project: &str,
    line_count: usize,
) -> CognitionResult<()> {
    let path = memory_root.join("queue/dead-letter.jsonl");
    ensure_data_authority(data_root, &[memory_root, &path])?;
    fs::create_dir_all(
        path.parent()
            .ok_or_else(|| failure(CognitionCode::LegacyDiagnosticFailed))?,
    )
    .map_err(|source| failure(CognitionCode::LegacyDiagnosticFailed).with_source(source))?;
    let mut file = butler_platform::secure_fs::append_private(&path)
        .map_err(|source| failure(CognitionCode::LegacyDiagnosticFailed).with_source(source))?;
    writeln!(file, "{}", json!({"timestamp": chrono::DateTime::<chrono::Utc>::from(std::time::SystemTime::now()).to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "reason":"session_sync_unparseable_transcript", "session_id":session_id, "project":project, "line_count":line_count}))
        .map_err(|source| failure(CognitionCode::LegacyDiagnosticFailed).with_source(source))
}

fn offset_path(memory_root: &Path) -> PathBuf {
    memory_root.join("db/session-sync-offset.json")
}
fn failure(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_offset_advances_only_after_explicit_save() {
        let root =
            std::env::temp_dir().join(format!("butler-legacy-offset-{}", uuid::Uuid::new_v4()));
        let memory = root.join("cognition/memory");
        let transcript = root.join("transcripts/session-a.jsonl");
        fs::create_dir_all(transcript.parent().unwrap()).unwrap();
        fs::write(&transcript, "one\n\n two\n").unwrap();
        let mut offsets = LegacySessionOffsets::load(&root, &memory).unwrap();
        let (first, next) = read_legacy_new_lines(&root, &transcript, "session-a", None).unwrap();
        assert_eq!(first, ["one", " two"]);
        assert_eq!(next.last_line, 2);
        assert_eq!(next.byte_offset, 10);
        // A failed downstream index must leave the durable cursor unchanged.
        assert!(
            LegacySessionOffsets::load(&root, &memory)
                .unwrap()
                .get("project:session-a")
                .is_none()
        );
        offsets.insert("project:session-a".into(), next);
        offsets.save(&root, &memory).unwrap();
        let loaded = LegacySessionOffsets::load(&root, &memory).unwrap();
        let (repeat, _) = read_legacy_new_lines(
            &root,
            &transcript,
            "session-a",
            loaded.get("project:session-a"),
        )
        .unwrap();
        assert_eq!(repeat, [] as [std::string::String; 0]);
        fs::remove_dir_all(root).unwrap();
    }
}
