//! Pure formatting and compaction for structured generation hot-cache entries.

use crate::public_text::fixed_regex::fixed_regex;
use std::{collections::HashSet, sync::OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::public_text::{trim_js_whitespace, trim_js_whitespace_end};

const DEFAULT_MAX_BYTES: usize = 20 * 1024;
const MAX_ENTRY_BODY_UTF16: usize = 8_000;
const SEMANTIC_PREFIX: &str = "<!-- butler-semantic:";
const STRUCTURED_PREFIX: &str = "<!-- butler-hot-cache-entry:v2\n";

pub(in crate::cognition) fn physical_entries(body: &str) -> Vec<Value> {
    scan_semantic_blocks(body)
        .into_iter()
        .filter_map(|block| {
            let text = &body[block.start..block.end];
            let start = text.find(STRUCTURED_PREFIX)? + STRUCTURED_PREFIX.len();
            let end = text[start..].find("\n-->")? + start;
            let value: Value = serde_json::from_str(&text[start..end]).ok()?;
            parse_structured_entry(text)?;
            Some(value)
        })
        .collect()
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct ExcludedEntry {
    pub(super) id: String,
    pub(super) reason: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct RenderedCache {
    pub(super) body: String,
    pub(super) audit: String,
    pub(super) admitted: bool,
    pub(super) replayed: bool,
    pub(super) compacted: bool,
    pub(super) excluded: Vec<ExcludedEntry>,
}

/// Renders a candidate entry into the managed structured cache blocks.
///
/// `valid_entry_ids` is the caller's snapshot of entries that still have current
/// graph evidence. The candidate must be present there to be admitted.
pub(super) fn render(
    existing: &str,
    new_entry: Option<&Value>,
    valid_entry_ids: &HashSet<String>,
    now_epoch_ms: i64,
) -> Result<RenderedCache, &'static str> {
    let candidate = new_entry.map(parse_candidate).transpose()?;
    let candidate_block = candidate.as_ref().map(render_entry_block).transpose()?;
    let candidate_id = candidate.as_ref().map(|entry| entry.entry_id.clone());
    let marker = candidate.as_ref().map(|entry| {
        format!(
            "<!-- butler-semantic:{}:start -->",
            safe_marker_id(&entry.entry_id)
        )
    });
    let replayed = marker
        .as_ref()
        .is_some_and(|marker| existing.contains(marker));

    let staged = match (candidate_block.as_deref(), replayed) {
        (Some(_), true) | (None, _) => existing.to_owned(),
        (Some(block), false) => append_block(existing, block),
    };

    let blocks = scan_semantic_blocks(&staged);
    let mut legacy_parts = Vec::new();
    let mut cursor = 0;
    for block in &blocks {
        legacy_parts.push(&staged[cursor..block.start]);
        cursor = block.end;
    }
    legacy_parts.push(&staged[cursor..]);
    let joined_legacy = legacy_parts.concat();
    let legacy = trim_js_whitespace(&joined_legacy);

    let mut audit_parts = Vec::new();
    if !legacy.is_empty() {
        audit_parts.push(legacy.to_owned());
    }

    let mut valid_blocks = Vec::new();
    let mut excluded = Vec::new();
    for block in blocks {
        let body = &staged[block.start..block.end];
        let Some(entry) = parse_structured_entry(body) else {
            audit_parts.push(trim_js_whitespace_end(body).to_owned());
            continue;
        };
        if is_expired(entry.valid_until.as_deref(), now_epoch_ms) {
            excluded.push(ExcludedEntry {
                id: entry.entry_id,
                reason: "expired",
            });
        } else if !valid_entry_ids.contains(&entry.entry_id) {
            excluded.push(ExcludedEntry {
                id: entry.entry_id,
                reason: "invalidated",
            });
        } else {
            valid_blocks.push(ParsedBlock {
                body: trim_js_whitespace_end(body).to_owned(),
                entry,
            });
        }
    }

    valid_blocks.sort_by(|left, right| {
        salience_rank(&left.entry.salience)
            .cmp(&salience_rank(&right.entry.salience))
            .then_with(|| {
                right
                    .entry
                    .source_time
                    .as_bytes()
                    .cmp(left.entry.source_time.as_bytes())
            })
            .then_with(|| {
                left.entry
                    .entry_id
                    .as_bytes()
                    .cmp(right.entry.entry_id.as_bytes())
            })
    });

    let mut deduped = Vec::new();
    let mut seen = HashSet::new();
    for block in valid_blocks {
        if seen.insert(block.entry.entry_id.clone()) {
            deduped.push(block);
        }
    }

    let mut admitted_blocks = Vec::new();
    let mut admitted_ids = HashSet::new();
    for block in deduped {
        let single_bytes = serialize_blocks(std::slice::from_ref(&block.body)).len();
        let mut candidate_blocks = admitted_blocks.clone();
        candidate_blocks.push(block.body.clone());
        if single_bytes > DEFAULT_MAX_BYTES {
            excluded.push(ExcludedEntry {
                id: block.entry.entry_id,
                reason: "oversized",
            });
        } else if serialize_blocks(&candidate_blocks).len() > DEFAULT_MAX_BYTES {
            excluded.push(ExcludedEntry {
                id: block.entry.entry_id,
                reason: "budget",
            });
        } else {
            admitted_ids.insert(block.entry.entry_id);
            admitted_blocks.push(block.body);
        }
    }

    let body = serialize_blocks(&admitted_blocks);
    let audit = if audit_parts.is_empty() {
        String::new()
    } else {
        format!("{}\n", audit_parts.join("\n\n"))
    };

    Ok(RenderedCache {
        compacted: body != staged,
        admitted: candidate_id.is_none_or(|id| admitted_ids.contains(&id)),
        replayed,
        body,
        audit,
        excluded,
    })
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct SourceBackedHotCacheEntry {
    entry_id: String,
    episode_id: String,
    window_ref: String,
    node_refs: Vec<String>,
    source_revision: String,
    source_time: String,
    #[serde(default)]
    valid_until: Option<String>,
    kind: String,
    summary: String,
    basis: Vec<String>,
    salience: Salience,
    scope: Scope,
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_kind: Option<SourceKind>,
    graph_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    authority: Option<Authority>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_class: Option<SourceClass>,
    source_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Salience {
    High,
    Normal,
    Unspecified,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Scope {
    Project,
    Global,
}

impl Scope {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::Global => "global",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum SourceKind {
    Conversation,
    TaskReport,
    ExplicitRecord,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Authority {
    ModelInterpretation,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum SourceClass {
    User,
    Assistant,
    TaskReport,
    Explicit,
    Mixed,
    Unknown,
}

struct ParsedBlock {
    body: String,
    entry: ParsedEntry,
}

struct ParsedEntry {
    entry_id: String,
    source_time: String,
    valid_until: Option<String>,
    salience: String,
}

struct SemanticBlock {
    start: usize,
    end: usize,
}

fn parse_candidate(value: &Value) -> Result<SourceBackedHotCacheEntry, &'static str> {
    let mut entry: SourceBackedHotCacheEntry =
        serde_json::from_value(value.clone()).map_err(|_| "hot_cache_entry_invalid")?;
    if entry.entry_id.is_empty()
        || entry.episode_id.is_empty()
        || entry.source_revision.is_empty()
        || entry.source_time.is_empty()
    {
        return Err("hot_cache_entry_invalid");
    }
    let body = trim_js_whitespace(&entry.summary);
    if body.is_empty() {
        return Err("hot_cache_entry_empty");
    }
    if body.encode_utf16().count() > MAX_ENTRY_BODY_UTF16 {
        return Err("hot_cache_entry_too_large");
    }
    if contains_secret(body) {
        return Err("hot_cache_secret_rejected");
    }
    entry.summary = body.to_owned();
    Ok(entry)
}

fn parse_structured_entry(block: &str) -> Option<ParsedEntry> {
    let start = block.find(STRUCTURED_PREFIX)? + STRUCTURED_PREFIX.len();
    let end = block[start..].find("\n-->")? + start;
    let value: Value = serde_json::from_str(&block[start..end]).ok()?;
    let entry_id = value.get("entry_id")?.as_str()?.to_owned();
    let episode_id = value.get("episode_id")?.as_str()?;
    let source_revision = value.get("source_revision")?.as_str()?;
    let summary = value.get("summary")?.as_str()?;
    let source_time = value.get("source_time")?.as_str()?;
    if entry_id.is_empty()
        || episode_id.is_empty()
        || source_revision.is_empty()
        || summary.is_empty()
    {
        return None;
    }
    Some(ParsedEntry {
        entry_id,
        source_time: source_time.to_owned(),
        valid_until: value
            .get("valid_until")
            .and_then(Value::as_str)
            .map(str::to_owned),
        salience: value
            .get("salience")
            .and_then(Value::as_str)
            .unwrap_or("unspecified")
            .to_owned(),
    })
}

fn render_entry_block(entry: &SourceBackedHotCacheEntry) -> Result<String, &'static str> {
    let source_id = &entry.entry_id;
    let marker_id = safe_marker_id(source_id);
    let project_id = entry
        .project_id
        .as_deref()
        .map(trim_js_whitespace)
        .filter(|value| !value.is_empty());
    let project_label = project_id.unwrap_or("global");
    let session_id = entry.session_id.as_deref().unwrap_or("null");
    let metadata = serde_json::to_string(entry).map_err(|_| "hot_cache_entry_invalid")?;

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

fn append_block(existing: &str, block: &str) -> String {
    let trimmed_end = trim_js_whitespace_end(existing);
    let separator = if trim_js_whitespace(existing).is_empty() {
        ""
    } else {
        "\n\n"
    };
    format!("{trimmed_end}{separator}{block}\n")
}

fn scan_semantic_blocks(body: &str) -> Vec<SemanticBlock> {
    let mut blocks = Vec::new();
    let mut cursor = 0;
    while let Some(relative_start) = body[cursor..].find(SEMANTIC_PREFIX) {
        let start = cursor + relative_start;
        let marker_start = start + SEMANTIC_PREFIX.len();
        let Some(relative_open_end) = body[marker_start..].find(":start -->") else {
            cursor = marker_start;
            continue;
        };
        let id_end = marker_start + relative_open_end;
        let id = &body[marker_start..id_end];
        if id.is_empty() || id.contains(':') || id.contains('>') {
            cursor = marker_start;
            continue;
        }
        let content_start = id_end + ":start -->".len();
        let end_marker = format!("<!-- butler-semantic:{id}:end -->");
        let Some(relative_end) = body[content_start..].find(&end_marker) else {
            cursor = marker_start;
            continue;
        };
        let marker_end = content_start + relative_end + end_marker.len();
        let end = if body[marker_end..].starts_with('\n') {
            marker_end + 1
        } else {
            marker_end
        };
        blocks.push(SemanticBlock { start, end });
        cursor = end;
    }
    blocks
}

fn is_expired(valid_until: Option<&str>, now_epoch_ms: i64) -> bool {
    valid_until
        .filter(|value| !value.is_empty())
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .is_some_and(|expiry| expiry.timestamp_millis() <= now_epoch_ms)
}

fn salience_rank(salience: &str) -> u8 {
    match salience {
        "high" => 0,
        "normal" => 1,
        _ => 2,
    }
}

fn serialize_blocks(blocks: &[String]) -> String {
    if blocks.is_empty() {
        String::new()
    } else {
        format!("{}\n", blocks.join("\n\n"))
    }
}

fn safe_marker_id(value: &str) -> String {
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

fn contains_secret(value: &str) -> bool {
    static SECRET_PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    SECRET_PATTERN
        .get_or_init(|| {
            fixed_regex(r"(?i)-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b|\bAKIA[0-9A-Z]{16}\b|\b(?:password|passwd|token|api[_ -]?key)\s*[:=]\s*[^\s]{8,}")
        })
        .is_match(value)
}
