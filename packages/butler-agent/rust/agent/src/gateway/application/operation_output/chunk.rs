use base64::Engine;
use rusqlite::Result as SqliteResult;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::super::storage::AppStorageError;

const CHUNK_BYTES: usize = 32 * 1024;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
const BASE64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        base64::engine::general_purpose::GeneralPurposeConfig::new()
            .with_decode_allow_trailing_bits(true),
    );

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct OperationOutputChunk {
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
    let first_request_id = first.request_id.clone();
    let first_result_id = first.result_id.clone();
    let first_result_sha256 = first.result_sha256.clone();
    let first_chunk_count = first.chunk_count;
    let first_byte_length = first.byte_length;

    let byte_start = requested_byte_start.min(byte_length);
    let page_end = byte_start
        .saturating_add(page_bytes as u64)
        .min(byte_length);
    let page_capacity = usize::try_from(page_end - byte_start).map_err(|_| {
        AppStorageError::new("operation_output_invalid", "Output page is too large")
    })?;
    let mut content = Vec::with_capacity(page_capacity);
    let mut expected_start = 0_i64;
    let mut seen_count = 0_usize;
    let mut result_hasher = Sha256::new();

    for row in std::iter::once(Ok(first)).chain(rows) {
        let row = row.map_err(AppStorageError::sqlite)?;
        let expected_index = i64::try_from(seen_count).ok();
        if row.request_id != first_request_id
            || row.result_id != first_result_id
            || row.result_sha256 != first_result_sha256
            || Some(row.chunk_index) != expected_index
            || seen_count >= chunk_count
            || row.chunk_count != first_chunk_count
            || row.byte_length != first_byte_length
            || row.byte_start != expected_start
            || row.byte_start < 0
            || row.byte_end < row.byte_start
            || row.byte_end > row.byte_length
            || row.byte_length < 0
        {
            return Ok(ChunkOutputRead::Invalid);
        }
        let Some(chunk) = base64::engine::general_purpose::STANDARD
            .decode(&row.content_base64)
            .ok()
        else {
            return Ok(ChunkOutputRead::Invalid);
        };
        if i64::try_from(chunk.len()).ok() != Some(row.byte_end - row.byte_start)
            || sha256(&chunk) != row.content_sha256
        {
            return Ok(ChunkOutputRead::Invalid);
        }
        result_hasher.update(&chunk);
        let chunk_start = row.byte_start as u64;
        let chunk_end = row.byte_end as u64;
        let overlap_start = chunk_start.max(byte_start);
        let overlap_end = chunk_end.min(page_end);
        if overlap_start < overlap_end {
            let local_start = usize::try_from(overlap_start - chunk_start).map_err(|_| {
                AppStorageError::new("operation_output_invalid", "Invalid chunk range")
            })?;
            let local_end = usize::try_from(overlap_end - chunk_start).map_err(|_| {
                AppStorageError::new("operation_output_invalid", "Invalid chunk range")
            })?;
            content.extend_from_slice(&chunk[local_start..local_end]);
        }
        expected_start = row.byte_end;
        seen_count += 1;
    }

    let result_sha256 = format!("{:x}", result_hasher.finalize());
    if seen_count != chunk_count
        || expected_start != first_byte_length
        || result_sha256 != first_result_sha256
        || result_id(&first_result_sha256) != expected_result_id
    {
        return Ok(ChunkOutputRead::Invalid);
    }
    let complete_length = complete_utf8_prefix(&content).len();
    content.truncate(complete_length);
    Ok(ChunkOutputRead::Complete(VerifiedOutputPage {
        byte_start,
        byte_length,
        content,
    }))
}

impl OperationOutputChunk {
    /// Projects an explicitly public, source-shaped progress event into the
    /// chunk contract used by the App output reader.
    pub(crate) fn from_public_event(
        event: &Value,
        expected_request_id: &str,
        expected_result_id: &str,
    ) -> Option<Self> {
        if event.get("kind")?.as_str()? != "operation.output.chunk"
            || event.get("visibility")?.as_str()? != "public"
        {
            return None;
        }
        let payload = event.get("payload")?.as_object()?;
        let chunk = Self {
            request_id: token(payload.get("requestId")?)?.to_owned(),
            result_id: token(payload.get("resultId")?)?.to_owned(),
            result_sha256: digest(payload.get("resultSha256")?)?.to_owned(),
            chunk_index: integer(payload.get("chunkIndex")?, false)?,
            chunk_count: integer(payload.get("chunkCount")?, true)?,
            byte_start: integer(payload.get("byteStart")?, false)?,
            byte_end: integer(payload.get("byteEnd")?, false)?,
            byte_length: integer(payload.get("byteLength")?, false)?,
            content_base64: payload.get("contentBase64")?.as_str()?.to_owned(),
            content_sha256: digest(payload.get("contentSha256")?)?.to_owned(),
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
        if i64::try_from(bytes.len()).ok()? != chunk.byte_end - chunk.byte_start
            || sha256(&bytes) != chunk.content_sha256
        {
            return None;
        }
        Some(chunk)
    }
}

fn token(value: &Value) -> Option<&str> {
    value
        .as_str()
        .filter(|value| !value.trim().is_empty() && value.encode_utf16().count() <= 512)
}

fn digest(value: &Value) -> Option<&str> {
    value.as_str().filter(|value| {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
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
        .and_then(|value| i64::try_from(value as u64).ok())
}

pub(super) fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn result_id(result_sha256: &str) -> String {
    sha256(format!("btcc-guided-tool-result.v1\0{result_sha256}").as_bytes())
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
