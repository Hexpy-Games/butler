use base64::Engine;
use rusqlite::Result as SqliteResult;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::super::storage::AppStorageError;
use crate::gateway::application::storage::AppStorageCode;

const CHUNK_BYTES: usize = 32 * 1024;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
const BASE64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        base64::engine::general_purpose::GeneralPurposeConfig::new()
            .with_decode_allow_trailing_bits(true),
    );

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationOutputChunk {
    pub request_id: String,
    pub result_id: String,
    pub result_sha256: String,
    pub chunk_index: i64,
    pub chunk_count: i64,
    pub byte_start: i64,
    pub byte_end: i64,
    pub byte_length: i64,
    pub content_base64: String,
    pub content_sha256: String,
}

pub(super) enum ChunkOutputRead {
    NoRows,
    Invalid,
    Complete(VerifiedOutputPage),
}

pub(super) struct VerifiedOutputPage {
    pub(super) byte_start: u64,
    pub(super) byte_length: u64,
    pub(super) content: Vec<u8>,
}

#[derive(Debug)]
pub(super) struct StoredChunk {
    pub(super) request_id: String,
    pub(super) result_id: String,
    pub(super) result_sha256: String,
    pub(super) chunk_index: i64,
    pub(super) chunk_count: i64,
    pub(super) byte_start: i64,
    pub(super) byte_end: i64,
    pub(super) byte_length: i64,
    pub(super) content_base64: String,
    pub(super) content_sha256: String,
}

impl From<OperationOutputChunk> for StoredChunk {
    fn from(chunk: OperationOutputChunk) -> Self {
        Self {
            request_id: chunk.request_id,
            result_id: chunk.result_id,
            result_sha256: chunk.result_sha256,
            chunk_index: chunk.chunk_index,
            chunk_count: chunk.chunk_count,
            byte_start: chunk.byte_start,
            byte_end: chunk.byte_end,
            byte_length: chunk.byte_length,
            content_base64: chunk.content_base64,
            content_sha256: chunk.content_sha256,
        }
    }
}

pub(super) fn verify_rows<I>(
    mut rows: I,
    expected_result_id: &str,
    requested_byte_start: u64,
    page_bytes: usize,
) -> Result<ChunkOutputRead, AppStorageError>
where
    I: Iterator<Item = SqliteResult<StoredChunk>>,
{
    let Some(first) = rows.next() else {
        return Ok(ChunkOutputRead::NoRows);
    };
    let first = first.map_err(AppStorageError::sqlite)?;
    let Ok(chunk_count) = usize::try_from(first.chunk_count) else {
        return Ok(ChunkOutputRead::Invalid);
    };
    let Ok(byte_length) = u64::try_from(first.byte_length) else {
        return Ok(ChunkOutputRead::Invalid);
    };
    if chunk_count == 0 || first.result_id != expected_result_id {
        return Ok(ChunkOutputRead::Invalid);
    }
    let layout = ChunkLayout {
        request_id: first.request_id.clone(),
        result_id: first.result_id.clone(),
        result_sha256: first.result_sha256.clone(),
        chunk_count: first.chunk_count,
        byte_length: first.byte_length,
    };

    let byte_start = requested_byte_start.min(byte_length);
    let page_end = byte_start
        .saturating_add(page_bytes as u64)
        .min(byte_length);
    let page_capacity = usize::try_from(page_end - byte_start).map_err(|source| {
        AppStorageError::new(
            AppStorageCode::OperationOutputInvalid,
            "Output page is too large",
        )
        .with_source(source)
    })?;
    let mut content = Vec::with_capacity(page_capacity);
    let mut expected_start = 0_i64;
    let mut seen_count = 0_usize;
    let mut result_hasher = Sha256::new();

    for row in std::iter::once(Ok(first)).chain(rows) {
        let row = row.map_err(AppStorageError::sqlite)?;
        let Some(chunk) = decode_stored_chunk(&row, &layout, seen_count, expected_start) else {
            return Ok(ChunkOutputRead::Invalid);
        };
        result_hasher.update(&chunk);
        append_page_overlap(&mut content, &chunk, row.byte_start, byte_start, page_end)?;
        expected_start = row.byte_end;
        seen_count += 1;
    }

    let result_sha256 = format!("{:x}", result_hasher.finalize());
    if seen_count != chunk_count || expected_start != layout.byte_length {
        return Ok(ChunkOutputRead::Invalid);
    }
    if result_sha256 != layout.result_sha256 {
        butler_core::diagnostic!(
            "warning: stored operation result hash mismatch for {expected_result_id}"
        );
    }
    let complete_length = complete_utf8_prefix(&content).len();
    content.truncate(complete_length);
    Ok(ChunkOutputRead::Complete(VerifiedOutputPage {
        byte_start,
        byte_length,
        content,
    }))
}

struct ChunkLayout {
    request_id: String,
    result_id: String,
    result_sha256: String,
    chunk_count: i64,
    byte_length: i64,
}

/// Identity/order/layout validation is separate from diagnostic content hashes.
fn decode_stored_chunk(
    row: &StoredChunk,
    layout: &ChunkLayout,
    index: usize,
    start: i64,
) -> Option<Vec<u8>> {
    if row.request_id != layout.request_id
        || row.result_id != layout.result_id
        || Some(row.chunk_index) != i64::try_from(index).ok()
        || row.chunk_index >= layout.chunk_count
        || row.chunk_count != layout.chunk_count
        || row.byte_length != layout.byte_length
        || row.byte_start != start
        || row.byte_start < 0
        || row.byte_end < row.byte_start
        || row.byte_end > row.byte_length
    {
        return None;
    }
    let chunk = base64::engine::general_purpose::STANDARD
        .decode(&row.content_base64)
        .ok()?;
    if i64::try_from(chunk.len()).ok() != Some(row.byte_end - row.byte_start) {
        return None;
    }
    if row.result_sha256 != layout.result_sha256 || sha256(&chunk) != row.content_sha256 {
        butler_core::diagnostic!(
            "warning: stored operation output hash mismatch for {}/{}",
            layout.request_id,
            layout.result_id
        );
    }
    Some(chunk)
}

/// Copies only the requested byte window while all chunks are still validated.
fn append_page_overlap(
    content: &mut Vec<u8>,
    chunk: &[u8],
    start: i64,
    page_start: u64,
    page_end: u64,
) -> Result<(), AppStorageError> {
    let chunk_start = u64::try_from(start).unwrap_or_default();
    let chunk_end = chunk_start.saturating_add(chunk.len() as u64);
    let overlap_start = chunk_start.max(page_start);
    let overlap_end = chunk_end.min(page_end);
    if overlap_start < overlap_end {
        let range_error = |source| {
            AppStorageError::new(
                AppStorageCode::OperationOutputInvalid,
                "Invalid chunk range",
            )
            .with_source(source)
        };
        let local_start = usize::try_from(overlap_start - chunk_start).map_err(range_error)?;
        let local_end = usize::try_from(overlap_end - chunk_start).map_err(range_error)?;
        content.extend_from_slice(&chunk[local_start..local_end]);
    }
    Ok(())
}

impl OperationOutputChunk {
    /// Projects an explicitly public, source-shaped progress event into the
    /// chunk contract used by the App output reader.
    pub fn from_public_event(
        event: &Value,
        expected_request_id: &str,
        expected_result_id: &str,
    ) -> Option<Self> {
        if event.get("kind")?.as_str()? != "operation.output.chunk"
            || event.get("visibility")?.as_str()? != "public"
        {
            return None;
        }
        Self::from_payload(
            event.get("payload")?.as_object()?,
            expected_request_id,
            expected_result_id,
        )
    }

    pub(crate) fn from_payload(
        payload: &serde_json::Map<String, Value>,
        expected_request_id: &str,
        expected_result_id: &str,
    ) -> Option<Self> {
        let chunk = Self {
            request_id: token(payload.get("requestId")?)?.to_owned(),
            result_id: token(payload.get("resultId")?)?.to_owned(),
            result_sha256: diagnostic_digest(payload.get("resultSha256")).to_owned(),
            chunk_index: integer(payload.get("chunkIndex")?, false)?,
            chunk_count: integer(payload.get("chunkCount")?, true)?,
            byte_start: integer(payload.get("byteStart")?, false)?,
            byte_end: integer(payload.get("byteEnd")?, false)?,
            byte_length: integer(payload.get("byteLength")?, false)?,
            content_base64: payload.get("contentBase64")?.as_str()?.to_owned(),
            content_sha256: diagnostic_digest(payload.get("contentSha256")).to_owned(),
        };
        if chunk.request_id != expected_request_id
            || chunk.result_id != expected_result_id
            || chunk.chunk_index >= chunk.chunk_count
            || chunk.byte_start > chunk.byte_end
            || chunk.byte_end > chunk.byte_length
            || chunk.content_base64.len() > CHUNK_BYTES * 2
        {
            return None;
        }
        let bytes = BASE64.decode(&chunk.content_base64).ok()?;
        if i64::try_from(bytes.len()).ok()? != chunk.byte_end - chunk.byte_start {
            return None;
        }
        if sha256(&bytes) != chunk.content_sha256 {
            butler_core::diagnostic!(
                "warning: operation chunk content hash mismatch for {expected_request_id}/{expected_result_id}"
            );
        }
        Some(chunk)
    }
}

fn token(value: &Value) -> Option<&str> {
    value
        .as_str()
        .filter(|value| !value.trim().is_empty() && value.encode_utf16().count() <= 512)
}

fn diagnostic_digest(value: Option<&Value>) -> &str {
    value.and_then(Value::as_str).unwrap_or_default()
}

fn integer(value: &Value, positive: bool) -> Option<i64> {
    value
        .as_f64()
        .filter(|value| {
            value.is_finite()
                && *value >= if positive { 1.0 } else { 0.0 }
                && *value <= MAX_SAFE_INTEGER
                && value.fract() == 0.0
        })
        .and_then(|value| i64::try_from(butler_core::json::saturating_u64(value)).ok())
}

pub(super) fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn complete_utf8_prefix(bytes: &[u8]) -> &[u8] {
    let Some(mut lead_index) = bytes.len().checked_sub(1) else {
        return bytes;
    };
    while lead_index > 0 && is_continuation_byte(bytes[lead_index]) {
        lead_index -= 1;
    }
    let expected = utf8_sequence_length(bytes[lead_index]);
    let available = bytes.len() - lead_index;
    if expected > available {
        &bytes[..lead_index]
    } else {
        bytes
    }
}

fn is_continuation_byte(value: u8) -> bool {
    value & 0xc0 == 0x80
}

fn utf8_sequence_length(value: u8) -> usize {
    if value & 0x80 == 0 {
        1
    } else if value & 0xe0 == 0xc0 {
        2
    } else if value & 0xf0 == 0xe0 {
        3
    } else if value & 0xf8 == 0xf0 {
        4
    } else {
        1
    }
}
