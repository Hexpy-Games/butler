use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};

use super::super::contracts::{
    CanonicalProfileScan, CanonicalProfileSourceFactory, CanonicalProfileSourceReader,
    ProfileResult, ProfileTranscriptCaptureOptions,
};
use super::super::storage;
use super::types::{EXTRACTOR_VERSION, MAX_SCAN_MESSAGES, SourceRead, SourceWindow};
use crate::segmentation::split_grapheme_utf8_spans;

pub(super) fn read(
    root: &Path,
    factory: &dyn CanonicalProfileSourceFactory,
    options: &ProfileTranscriptCaptureOptions,
) -> ProfileResult<SourceRead> {
    let limit = options
        .max_user_messages
        .filter(|value| value.is_finite())
        .unwrap_or(1_200.0)
        .clamp(1.0, MAX_SCAN_MESSAGES as f64)
        .ceil() as usize;
    let since = normalized_since(options.since.as_deref());
    let since_ms = since
        .as_deref()
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.timestamp_millis());
    let mut reader = factory.open()?;
    let result = read_owned(root, reader.as_mut(), limit, since, since_ms);
    let close = reader.close();
    close?;
    result
}

fn read_owned(
    root: &Path,
    reader: &mut dyn CanonicalProfileSourceReader,
    limit: usize,
    since: Option<String>,
    since_ms: Option<i64>,
) -> ProfileResult<SourceRead> {
    let incomplete = incomplete_windows(root, reader, since_ms, limit)?;
    let mut windows = incomplete.windows;
    let mut seen = windows
        .iter()
        .map(|window| window.coverage_key.clone())
        .collect::<HashSet<_>>();
    let mut sessions = HashSet::new();
    let mut source_rows = 0usize;
    let mut canonical_scanned = 0usize;
    let persistent = since.is_none();
    let mut offset = if persistent { scan_offset(root) } else { 0 };
    let mut reached_end = false;
    let mut stopped = false;
    while source_rows < MAX_SCAN_MESSAGES && windows.len() < limit {
        let page_limit = 1_000usize.min(MAX_SCAN_MESSAGES - source_rows);
        let page = reader.read_cognition_messages(CanonicalProfileScan {
            since: since.clone(),
            offset: offset as f64,
            limit: page_limit as f64,
        })?;
        if page.is_empty() {
            reached_end = true;
            break;
        }
        source_rows += page.len();
        let page_offset = offset;
        for (index, message) in page.iter().enumerate() {
            offset = page_offset + index;
            if message.role != "user" || message.origin_kind != "user_input" {
                offset += 1;
                continue;
            }
            canonical_scanned += 1;
            sessions.insert(message.session_id.clone());
            'parts: for part in &message.parts {
                for scalar in &part.scalars {
                    for (start, end) in source_spans(&scalar.text) {
                        if windows.len() >= limit {
                            stopped = true;
                            break 'parts;
                        }
                        let window = make_window(SourceWindowInput {
                            message_id: &message.id,
                            timestamp: &message.created_at,
                            part_id: &part.part_id,
                            part_index: part.part_index,
                            scalar_pointer: &scalar.pointer,
                            source_hash: &scalar.source_hash,
                            text: &scalar.text,
                            byte_start: start,
                            byte_end: end,
                        });
                        if seen.contains(&window.coverage_key) || span_registered(root, &window) {
                            continue;
                        }
                        seen.insert(window.coverage_key.clone());
                        windows.push(window);
                    }
                }
            }
            if windows.len() >= limit {
                stopped = true;
                break;
            }
            offset = page_offset + index + 1;
        }
        if !stopped && page.len() < page_limit {
            reached_end = true;
            break;
        }
    }
    Ok(SourceRead {
        scanned_session_count: sessions.len(),
        scanned_message_count: canonical_scanned,
        current_obligation_count: windows.len() + usize::from(incomplete.has_more),
        windows,
        discovery_incomplete: incomplete.has_more || !reached_end || stopped,
        stale_keys: incomplete.stale,
        persistent_offset: persistent.then_some(if reached_end { 0 } else { offset }),
    })
}

struct Incomplete {
    windows: Vec<SourceWindow>,
    has_more: bool,
    stale: Vec<String>,
}

fn incomplete_windows(
    root: &Path,
    reader: &mut dyn CanonicalProfileSourceReader,
    since_ms: Option<i64>,
    limit: usize,
) -> ProfileResult<Incomplete> {
    if !storage::database_path(root).exists() {
        return Ok(Incomplete {
            windows: Vec::new(),
            has_more: false,
            stale: Vec::new(),
        });
    }
    let db = storage::open(root, false)?;
    let query_limit = MAX_SCAN_MESSAGES.min(limit.saturating_mul(4).saturating_add(1));
    let since = since_ms
        .and_then(chrono::DateTime::from_timestamp_millis)
        .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    let rows = (|| {
        let mut statement = db.prepare("SELECT coverage_key,message_id,source_hash,part_id,part_index,scalar_pointer,byte_start,byte_end,observed_at,evidence_ref FROM profile_source_coverage WHERE disposition IN ('pending','failed') AND COALESCE(failure_code,'')!='source_stale' AND (?1 IS NULL OR observed_at>=?1) ORDER BY observed_at,message_id,part_index,scalar_pointer,byte_start LIMIT ?2").map_err(storage::db_error)?;
        statement
            .query_map(params![since, query_limit as i64], |row| {
                Ok(SourceWindow {
                    coverage_key: row.get(0)?,
                    message_id: row.get(1)?,
                    source_hash: row.get(2)?,
                    part_id: row.get(3)?,
                    part_index: row.get(4)?,
                    scalar_pointer: row.get(5)?,
                    byte_start: row.get::<_, i64>(6)?.max(0) as usize,
                    byte_end: row.get::<_, i64>(7)?.max(0) as usize,
                    timestamp: row.get(8)?,
                    evidence_ref: row.get(9)?,
                    text: Arc::from(""),
                })
            })
            .map_err(storage::db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage::db_error)
    })()
    .unwrap_or_default();
    drop(db);
    let mut current = Vec::new();
    let mut stale = Vec::new();
    for mut window in rows.iter().cloned() {
        if let Some(text) = current_text(reader, &window)? {
            window.text = Arc::from(text);
            current.push(window);
        } else {
            stale.push(window.coverage_key);
        }
    }
    Ok(Incomplete {
        has_more: current.len() > limit || rows.len() == query_limit,
        windows: current.into_iter().take(limit).collect(),
        stale,
    })
}

pub(super) fn current_text(
    reader: &mut dyn CanonicalProfileSourceReader,
    window: &SourceWindow,
) -> ProfileResult<Option<String>> {
    let Some(message) = reader.read_message(&window.message_id)? else {
        return Ok(None);
    };
    if message.role != "user" || message.origin_kind != "user_input" {
        return Ok(None);
    }
    let scalar = message
        .parts
        .iter()
        .find(|part| part.part_id == window.part_id)
        .and_then(|part| {
            part.scalars.iter().find(|scalar| {
                scalar.pointer == window.scalar_pointer && scalar.source_hash == window.source_hash
            })
        });
    let Some(text) = scalar.map(|value| value.text.as_str()) else {
        return Ok(None);
    };
    Ok(text
        .get(window.byte_start..window.byte_end)
        .filter(|value| !value.is_empty())
        .map(str::to_owned))
}

pub(super) fn make_window(input: SourceWindowInput<'_>) -> SourceWindow {
    let SourceWindowInput {
        message_id,
        timestamp,
        part_id,
        part_index,
        scalar_pointer,
        source_hash,
        text,
        byte_start,
        byte_end,
    } = input;
    let identity = format!(
        "{message_id}\0{source_hash}\0{part_id}\0{scalar_pointer}\0{byte_start}\0{byte_end}\0{EXTRACTOR_VERSION}"
    );
    let key = format!("{:x}", Sha256::digest(identity.as_bytes()));
    SourceWindow {
        text: Arc::from(&text[byte_start..byte_end]),
        evidence_ref: format!("profile_window:{}", &key[..24]),
        timestamp: timestamp.to_owned(),
        message_id: message_id.to_owned(),
        part_id: part_id.to_owned(),
        part_index,
        scalar_pointer: scalar_pointer.to_owned(),
        source_hash: source_hash.to_owned(),
        byte_start,
        byte_end,
        coverage_key: key,
    }
}

pub(super) struct SourceWindowInput<'a> {
    pub(super) message_id: &'a str,
    pub(super) timestamp: &'a str,
    pub(super) part_id: &'a str,
    pub(super) part_index: f64,
    pub(super) scalar_pointer: &'a str,
    pub(super) source_hash: &'a str,
    pub(super) text: &'a str,
    pub(super) byte_start: usize,
    pub(super) byte_end: usize,
}

fn source_spans(text: &str) -> Vec<(usize, usize)> {
    let mut maximum = 8_192.0;
    while maximum >= 256.0 {
        let spans = split_grapheme_utf8_spans(text, maximum);
        if spans.iter().all(|span| !span.oversized) {
            return spans
                .into_iter()
                .map(|span| (span.start, span.end))
                .collect();
        }
        maximum = (maximum / 2.0).floor();
    }
    split_grapheme_utf8_spans(text, 256.0)
        .into_iter()
        .map(|span| (span.start, span.end))
        .collect()
}

fn normalized_since(value: Option<&str>) -> Option<String> {
    let parsed = chrono::DateTime::parse_from_rfc3339(value?).ok()?;
    (parsed.timestamp_millis() > 0).then(|| {
        parsed
            .to_utc()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    })
}

fn scan_offset(root: &Path) -> usize {
    let Ok(db) = storage::open(root, false) else {
        return 0;
    };
    db.query_row(
        "SELECT value_json FROM profile_meta WHERE key='source_scan_offset'",
        [],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
    .and_then(|raw| serde_json::from_str::<usize>(&raw).ok())
    .unwrap_or(0)
}

fn span_registered(root: &Path, window: &SourceWindow) -> bool {
    let Ok(db) = storage::open(root, false) else {
        return false;
    };
    if db
        .query_row(
            "SELECT 1 FROM profile_source_coverage WHERE coverage_key=?1 LIMIT 1",
            [&window.coverage_key],
            |_| Ok(()),
        )
        .optional()
        .ok()
        .flatten()
        .is_some()
    {
        return true;
    }
    contiguous_children(&db, window).unwrap_or(false)
}

fn contiguous_children(db: &Connection, window: &SourceWindow) -> ProfileResult<bool> {
    let mut statement = db.prepare("SELECT byte_start,byte_end FROM profile_source_coverage WHERE message_id=?1 AND source_hash=?2 AND part_id=?3 AND scalar_pointer=?4 AND byte_start>=?5 AND byte_end<=?6 AND COALESCE(failure_code,'')!='source_stale' ORDER BY byte_start,byte_end LIMIT 512").map_err(storage::db_error)?;
    let rows = statement
        .query_map(
            params![
                window.message_id,
                window.source_hash,
                window.part_id,
                window.scalar_pointer,
                window.byte_start as i64,
                window.byte_end as i64
            ],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .map_err(storage::db_error)?;
    let mut cursor = window.byte_start as i64;
    for row in rows {
        let (start, end) = row.map_err(storage::db_error)?;
        if start != cursor || end <= cursor {
            return Ok(false);
        }
        cursor = end;
        if cursor == window.byte_end as i64 {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests;
