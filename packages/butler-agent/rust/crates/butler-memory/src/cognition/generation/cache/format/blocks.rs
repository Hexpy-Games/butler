//! Semantic hot-cache blocks: scanning, parsing, validating and rendering the marker-delimited entries.

use super::*;

pub(super) struct ParsedBlock {
    pub(super) body: String,
    pub(super) entry: ParsedEntry,
}

pub(super) struct ParsedEntry {
    pub(super) entry_id: String,
    pub(super) source_time: String,
    pub(super) valid_until: Option<String>,
    pub(super) salience: Salience,
}

pub(super) struct SemanticBlock {
    pub(super) start: usize,
    pub(super) end: usize,
}

pub(super) fn validate_candidate(
    mut entry: SourceBackedHotCacheEntry,
) -> Result<SourceBackedHotCacheEntry, CognitionError> {
    if entry.entry_id.is_empty()
        || entry.episode_id.is_empty()
        || entry.source_revision.is_empty()
        || entry.source_time.is_empty()
    {
        return Err(invalid(CognitionCode::HotCacheEntryInvalid));
    }
    let body = trim_js_whitespace(&entry.summary);
    if body.is_empty() {
        return Err(invalid(CognitionCode::HotCacheEntryEmpty));
    }
    if body.encode_utf16().count() > MAX_ENTRY_BODY_UTF16 {
        return Err(invalid(CognitionCode::HotCacheEntryTooLarge));
    }
    if contains_secret(body) {
        return Err(invalid(CognitionCode::HotCacheSecretRejected));
    }
    entry.summary = body.to_owned();
    Ok(entry)
}

pub(super) fn parse_structured_entry(block: &str) -> Option<ParsedEntry> {
    #[derive(Deserialize)]
    struct Required {
        entry_id: String,
        episode_id: String,
        source_revision: String,
        summary: String,
        source_time: String,
        #[serde(default, deserialize_with = "crate::lenient::option")]
        valid_until: Option<String>,
        #[serde(default, deserialize_with = "crate::lenient::option")]
        salience: Option<Salience>,
    }
    let value: Value = serde_json::from_str(structured_metadata(block)?).ok()?;
    if !value.is_object() {
        return None;
    }
    let entry = Required::deserialize(&value).ok()?;
    if entry.entry_id.is_empty()
        || entry.episode_id.is_empty()
        || entry.source_revision.is_empty()
        || entry.summary.is_empty()
    {
        return None;
    }
    Some(ParsedEntry {
        entry_id: entry.entry_id,
        source_time: entry.source_time,
        valid_until: entry.valid_until,
        salience: entry.salience.unwrap_or(Salience::Unspecified),
    })
}

pub(super) fn render_entry_block(
    entry: &SourceBackedHotCacheEntry,
) -> Result<String, CognitionError> {
    let source_id = &entry.entry_id;
    let marker_id = safe_marker_id(source_id);
    let project_id = entry
        .project_id
        .as_deref()
        .map(trim_js_whitespace)
        .filter(|value| !value.is_empty());
    let project_label = project_id.unwrap_or("global");
    let session_id = entry.session_id.as_deref().unwrap_or("null");
    let metadata = serde_json::to_string(entry)
        .map_err(|source| invalid(CognitionCode::HotCacheEntryInvalid).with_source(source))?;

    let mut lines = vec![
        format!("<!-- butler-semantic:{marker_id}:start -->"),
        format!("<!-- butler-hot-cache-entry:v2\n{metadata}\n-->"),
        format!("## [{}] {project_label} | {session_id}", entry.source_time),
        format!("- source_id: {source_id}"),
        format!("- scope: {}", entry.scope.as_str()),
    ];
    if let Some(project_id) = project_id {
        lines.push(format!("- project_id: {project_id}"));
    }
    lines.push(entry.summary.clone());
    lines.push(format!("<!-- butler-semantic:{marker_id}:end -->"));
    Ok(lines.join("\n"))
}

pub(super) fn append_block(existing: &str, block: &str) -> String {
    let trimmed_end = trim_js_whitespace_end(existing);
    let separator = if trim_js_whitespace(existing).is_empty() {
        ""
    } else {
        "\n\n"
    };
    format!("{trimmed_end}{separator}{block}\n")
}

/// Every `butler-semantic` block with a matching end marker, in order. A
/// block's span includes one trailing newline.
pub(super) fn scan_semantic_blocks(body: &str) -> Vec<SemanticBlock> {
    let mut blocks = Vec::new();
    let mut cursor = 0;
    while let Some(start) = body
        .get(cursor..)
        .and_then(|rest| rest.find(SEMANTIC_PREFIX))
        .map(|relative| cursor + relative)
    {
        let marker_start = start + SEMANTIC_PREFIX.len();
        match block_end(body, marker_start) {
            Some(end) => {
                blocks.push(SemanticBlock { start, end });
                cursor = end;
            }
            None => cursor = marker_start,
        }
    }
    blocks
}

/// The end of a block whose id starts at `marker_start`, or `None` when the
/// id is malformed or never closed.
pub(super) fn block_end(body: &str, marker_start: usize) -> Option<usize> {
    let rest = body.get(marker_start..)?;
    let id = rest.get(..rest.find(":start -->")?)?;
    if id.is_empty() || id.contains(':') || id.contains('>') {
        return None;
    }
    let content_start = marker_start + id.len() + ":start -->".len();
    let end_marker = format!("<!-- butler-semantic:{id}:end -->");
    let marker_end =
        content_start + body.get(content_start..)?.find(&end_marker)? + end_marker.len();
    let trailing_newline = body.get(marker_end..)?.starts_with('\n');
    Some(marker_end + usize::from(trailing_newline))
}

pub(super) fn is_expired(valid_until: Option<&str>, now_epoch_ms: i64) -> bool {
    valid_until
        .filter(|value| !value.is_empty())
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .is_some_and(|expiry| expiry.timestamp_millis() <= now_epoch_ms)
}

pub(super) fn serialize_blocks(blocks: &[String]) -> String {
    if blocks.is_empty() {
        String::new()
    } else {
        format!("{}\n", blocks.join("\n\n"))
    }
}

pub(super) fn safe_marker_id(value: &str) -> String {
    let compact = value
        .trim()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .take(120)
        .collect::<String>();
    if compact.is_empty() {
        // Hex of the first 16 digest bytes.
        let mut hex = format!("{:x}", Sha256::digest(value.as_bytes()));
        hex.truncate(32);
        hex
    } else {
        compact
    }
}

pub(super) fn contains_secret(value: &str) -> bool {
    static SECRET_PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    SECRET_PATTERN
        .get_or_init(|| {
            fixed_regex(r"(?i)-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b|\bAKIA[0-9A-Z]{16}\b|\b(?:password|passwd|token|api[_ -]?key)\s*[:=]\s*[^\s]{8,}")
        })
        .is_match(value)
}
