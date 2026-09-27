use std::{
    fs::File,
    io::{BufRead, BufReader},
    path::Path,
};

use serde_json::Value;

use butler_turn::conversation::ConversationSourceReader;
use butler_turn::conversation::conversation_session_id_for_durable_session;
use butler_turn::conversation::conversation_store_path;
use butler_turn::workspace::StatusSessionIdentity;
use butler_turn::workspace::read_active_butler_session;
use butler_turn::workspace::session_store_path;

const SEMANTIC_TAIL_LIMIT: u64 = 200;
const MAX_TRANSCRIPT_LINE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StatusFact<T> {
    Available(T),
    Unavailable(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActiveButlerSession {
    pub(crate) session_id: String,
    pub model_ref: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StatusConversationSummary {
    pub(crate) exists: Option<bool>,
    pub(crate) session_id: String,
    pub(crate) semantic_messages: Option<u64>,
    pub(crate) compacted_messages: Option<u64>,
    pub(crate) summaries: Option<u64>,
    pub(crate) latest_message_timestamp: Option<String>,
    pub(crate) prompt_token_estimate: Option<u64>,
    pub(crate) unavailable_reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StatusConversationFacts {
    pub active_session: StatusFact<Option<ActiveButlerSession>>,
    pub active_transcript_tokens: StatusFact<u64>,
    pub(crate) conversation: StatusConversationSummary,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StatusTranscriptSummary {
    pub(crate) exists: Option<bool>,
    pub(crate) bytes: Option<u64>,
    pub(crate) events: Option<u64>,
    pub(crate) conversation_events: Option<u64>,
    pub(crate) latest_timestamp: Option<String>,
    pub(crate) parse_errors: Option<u64>,
    pub(crate) unavailable_reason: Option<String>,
}

#[derive(Default)]
struct TranscriptScan {
    events: u64,
    conversation_events: u64,
    latest_timestamp: Option<String>,
    parse_errors: u64,
    payload_chars: u64,
    payload_events: u64,
}

pub fn read_status_conversation_facts(
    data_root: &Path,
    conversation_session_id: &str,
) -> StatusConversationFacts {
    let (active_session, active_transcript_tokens) =
        read_active_session_facts(data_root, &session_store_path(data_root));
    let conversation =
        read_conversation_summary(&conversation_store_path(data_root), conversation_session_id);
    StatusConversationFacts {
        active_session,
        active_transcript_tokens,
        conversation,
    }
}

fn read_active_session_facts(
    data_root: &Path,
    store_path: &Path,
) -> (StatusFact<Option<ActiveButlerSession>>, StatusFact<u64>) {
    match read_active_butler_session(store_path) {
        Ok(session) => {
            let transcript_tokens = match session.as_ref() {
                Some(session) => read_transcript_tokens(data_root, session),
                None => StatusFact::Available(0),
            };
            (
                StatusFact::Available(session.map(|session| active_session(&session))),
                transcript_tokens,
            )
        }
        Err(error) => {
            let reason = error.code().to_owned();
            (
                StatusFact::Unavailable(reason.clone()),
                StatusFact::Unavailable(reason),
            )
        }
    }
}

fn active_session(session: &StatusSessionIdentity) -> ActiveButlerSession {
    ActiveButlerSession {
        session_id: session.session_id.clone(),
        model_ref: session.model_ref.clone(),
    }
}

fn read_transcript_tokens(data_root: &Path, session: &StatusSessionIdentity) -> StatusFact<u64> {
    let path = data_root
        .join("transcripts")
        .join(format!("{}.jsonl", safe_session_id(&session.session_id)));
    match transcript_payload_chars(&path) {
        Ok(chars) => StatusFact::Available(chars.div_ceil(4)),
        Err(error) => StatusFact::Unavailable(error.reason().to_owned()),
    }
}

/// Why a transcript could not be scanned for status reporting. `reason()` is
/// the value reported in status output.
#[derive(Debug, thiserror::Error)]
pub(crate) enum TranscriptScanError {
    /// The transcripts directory could not be listed.
    #[error("transcript_directory_unavailable")]
    Directory(#[source] std::io::Error),
    /// A transcript's metadata could not be read.
    #[error("transcript_metadata_unavailable")]
    Metadata(#[source] std::io::Error),
    /// A transcript could not be opened, read or re-encoded.
    #[error("transcript_read_unavailable")]
    Read(#[source] Box<dyn std::error::Error + Send + Sync>),
}

impl TranscriptScanError {
    pub(crate) fn reason(&self) -> &'static str {
        match self {
            Self::Directory(_) => "transcript_directory_unavailable",
            Self::Metadata(_) => "transcript_metadata_unavailable",
            Self::Read(_) => "transcript_read_unavailable",
        }
    }

    pub(crate) fn read(source: impl Into<Box<dyn std::error::Error + Send + Sync>>) -> Self {
        Self::Read(source.into())
    }
}

fn transcript_payload_chars(path: &Path) -> Result<u64, TranscriptScanError> {
    scan_transcript(path, None).map(|scan| {
        scan.payload_chars
            .saturating_add(scan.payload_events.saturating_sub(1))
    })
}

pub fn read_status_transcript_summary(
    data_root: &Path,
    session_id: &str,
) -> StatusTranscriptSummary {
    let path = data_root
        .join("transcripts")
        .join(format!("{}.jsonl", safe_session_id(session_id)));
    let metadata = match std::fs::metadata(&path) {
        Ok(metadata) if metadata.is_file() => metadata,
        Ok(_) => return unavailable_transcript_summary(None, None, "transcript_not_file"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return empty_transcript_summary();
        }
        Err(_) => {
            return unavailable_transcript_summary(None, None, "transcript_metadata_unavailable");
        }
    };
    let bytes = metadata.len();
    match scan_transcript(&path, Some(MAX_TRANSCRIPT_LINE_BYTES)) {
        Ok(scan) => StatusTranscriptSummary {
            exists: Some(true),
            bytes: Some(bytes),
            events: Some(scan.events),
            conversation_events: Some(scan.conversation_events),
            latest_timestamp: scan.latest_timestamp,
            parse_errors: Some(scan.parse_errors),
            unavailable_reason: None,
        },
        Err(error) => unavailable_transcript_summary(Some(true), Some(bytes), error.reason()),
    }
}

fn scan_transcript(
    path: &Path,
    max_line_bytes: Option<usize>,
) -> Result<TranscriptScan, TranscriptScanError> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(TranscriptScan::default());
        }
        Err(error) => return Err(TranscriptScanError::read(error)),
    };
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    let mut scan = TranscriptScan::default();
    loop {
        line.clear();
        let bytes = reader
            .read_until(b'\n', &mut line)
            .map_err(TranscriptScanError::read)?;
        if bytes == 0 {
            break;
        }
        let complete = line.last() == Some(&b'\n');
        if complete {
            line.pop();
        }
        if max_line_bytes.is_some_and(|limit| line.len() > limit) {
            if complete {
                scan.parse_errors = scan.parse_errors.saturating_add(1);
            }
            continue;
        }
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        let decoded = String::from_utf8_lossy(&line);
        let trimmed = decoded.trim();
        if trimmed.is_empty() {
            continue;
        }
        let event = match serde_json::from_str::<Value>(trimmed) {
            Ok(event) if event.is_object() || event.is_array() => event,
            _ => {
                scan.parse_errors = scan.parse_errors.saturating_add(1);
                continue;
            }
        };
        scan.events = scan.events.saturating_add(1);
        if matches!(
            event.get("kind").and_then(Value::as_str),
            Some("inbound" | "outbound")
        ) {
            scan.conversation_events = scan.conversation_events.saturating_add(1);
        }
        if let Some(timestamp) = event.get("timestamp").and_then(Value::as_str) {
            scan.latest_timestamp = Some(timestamp.to_owned());
        }
        if valid_transcript_event(&event) {
            let serialized =
                serde_json::to_string(&event["payload"]).map_err(TranscriptScanError::read)?;
            scan.payload_chars = scan
                .payload_chars
                .saturating_add(serialized.encode_utf16().count() as u64);
            scan.payload_events = scan.payload_events.saturating_add(1);
        }
    }
    Ok(scan)
}

fn empty_transcript_summary() -> StatusTranscriptSummary {
    StatusTranscriptSummary {
        exists: Some(false),
        bytes: Some(0),
        events: Some(0),
        conversation_events: Some(0),
        latest_timestamp: None,
        parse_errors: Some(0),
        unavailable_reason: None,
    }
}

fn unavailable_transcript_summary(
    exists: Option<bool>,
    bytes: Option<u64>,
    reason: &str,
) -> StatusTranscriptSummary {
    StatusTranscriptSummary {
        exists,
        bytes,
        events: None,
        conversation_events: None,
        latest_timestamp: None,
        parse_errors: None,
        unavailable_reason: Some(reason.to_owned()),
    }
}

fn valid_transcript_event(event: &Value) -> bool {
    ["eventId", "sessionId", "kind", "timestamp"]
        .iter()
        .all(|key| event.get(key).and_then(Value::as_str).is_some())
        && event.get("payload").is_some_and(Value::is_object)
}

fn safe_session_id(session_id: &str) -> String {
    session_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn read_conversation_summary(path: &Path, durable_session_id: &str) -> StatusConversationSummary {
    let fallback = conversation_session_id_for_durable_session(durable_session_id);
    match std::fs::metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return empty_conversation_summary(fallback);
        }
        Err(_) => {
            return unavailable_conversation_summary(fallback, "conversation_store_unavailable");
        }
        Ok(_) => {}
    }

    let reader = match ConversationSourceReader::open(path) {
        Ok(reader) => reader,
        Err(error) => return unavailable_conversation_summary(fallback, error.code()),
    };
    let summary: Result<StatusConversationSummary, butler_turn::conversation::ConversationError> =
        (|| {
            let canonical_exists = reader.read_session(durable_session_id)?.is_some();
            let session_id = if canonical_exists {
                durable_session_id.to_owned()
            } else {
                fallback.clone()
            };
            let exists = if canonical_exists {
                true
            } else {
                reader.read_session(&session_id)?.is_some()
            };
            let stats = reader.read_status_context_stats(&session_id, SEMANTIC_TAIL_LIMIT)?;
            Ok(StatusConversationSummary {
                exists: Some(exists),
                session_id,
                semantic_messages: Some(stats.messages.semantic_messages),
                compacted_messages: Some(stats.messages.compacted_messages),
                summaries: Some(stats.summaries.summaries),
                latest_message_timestamp: stats.messages.latest_message_timestamp,
                prompt_token_estimate: Some(stats.prompt_token_estimate),
                unavailable_reason: None,
            })
        })();
    match (summary, reader.close()) {
        (Ok(summary), Ok(())) => summary,
        (Err(error), _) | (Ok(_), Err(error)) => {
            unavailable_conversation_summary(fallback, error.code())
        }
    }
}

fn empty_conversation_summary(session_id: String) -> StatusConversationSummary {
    StatusConversationSummary {
        exists: Some(false),
        session_id,
        semantic_messages: Some(0),
        compacted_messages: Some(0),
        summaries: Some(0),
        latest_message_timestamp: None,
        prompt_token_estimate: Some(0),
        unavailable_reason: None,
    }
}

fn unavailable_conversation_summary(
    session_id: String,
    reason: impl Into<String>,
) -> StatusConversationSummary {
    StatusConversationSummary {
        exists: None,
        session_id,
        semantic_messages: None,
        compacted_messages: None,
        summaries: None,
        latest_message_timestamp: None,
        prompt_token_estimate: None,
        unavailable_reason: Some(reason.into()),
    }
}

#[cfg(test)]
mod tests;
