use crate::public_text::fixed_regex::fixed_regex;
use std::collections::HashSet;

use serde_json::Value;

const MAX_BYTES: usize = 20 * 1024;
const SEMANTIC_PREFIX: &str = "<!-- butler-semantic:";
const ENTRY_PREFIX: &str = "<!-- butler-hot-cache-entry:v2\n";

struct Block {
    raw: String,
    entry: Option<Entry>,
}

struct Entry {
    id: String,
    source_time: String,
    salience: String,
    valid_until: Option<String>,
}

pub(in crate::cognition) struct CompactedCache {
    pub(in crate::cognition) body: String,
    pub(in crate::cognition) audit: String,
}

pub(in crate::cognition) fn compact_hot_cache(body: &str) -> CompactedCache {
    let blocks = semantic_blocks(body);
    let mut legacy = String::new();
    let mut cursor = 0;
    for block in &blocks {
        legacy.push_str(&body[cursor..block.0]);
        cursor = block.1;
    }
    legacy.push_str(&body[cursor..]);
    let legacy = crate::public_text::trim_js_whitespace(&legacy).to_owned();
    let mut audit = Vec::new();
    if !legacy.is_empty() {
        audit.push(legacy.clone());
    }
    let parsed = blocks
        .into_iter()
        .map(|(start, end)| {
            let raw = body[start..end].to_owned();
            let entry = parse_entry(&raw);
            Block { raw, entry }
        })
        .collect::<Vec<_>>();
    let mut structured = Vec::new();
    let mut legacy_blocks = Vec::new();
    for block in parsed {
        match block.entry {
            Some(entry) if !expired(entry.valid_until.as_deref()) => {
                structured.push((block.raw.trim_end().to_owned(), entry));
            }
            Some(_) => {}
            None => {
                audit.push(crate::public_text::trim_js_whitespace_end(&block.raw).to_owned());
                legacy_blocks
                    .push(crate::public_text::trim_js_whitespace_end(&block.raw).to_owned());
            }
        }
    }
    structured.sort_by(|left, right| {
        salience_rank(&left.1.salience)
            .cmp(&salience_rank(&right.1.salience))
            .then_with(|| {
                right
                    .1
                    .source_time
                    .as_bytes()
                    .cmp(left.1.source_time.as_bytes())
            })
            .then_with(|| left.1.id.as_bytes().cmp(right.1.id.as_bytes()))
    });
    let mut seen = HashSet::new();
    structured.retain(|(_, entry)| seen.insert(entry.id.clone()));
    let mut admitted = Vec::new();
    for (raw, entry) in structured {
        let single_bytes = serialize_blocks(std::slice::from_ref(&raw)).len();
        let mut candidate = admitted.clone();
        candidate.push(raw.clone());
        if single_bytes <= MAX_BYTES && serialize_blocks(&candidate).len() <= MAX_BYTES {
            admitted.push(raw);
        } else {
            let _ = entry;
        }
    }
    let mut bytes = serialize_blocks(&admitted).len();
    let mut retained_legacy = Vec::new();
    for block in legacy_blocks.into_iter().rev() {
        let separator = if !admitted.is_empty() || !retained_legacy.is_empty() {
            "\n\n"
        } else {
            ""
        };
        if bytes + separator.len() + block.len() < MAX_BYTES {
            retained_legacy.insert(0, block.clone());
            bytes += separator.len() + block.len() + 1;
        }
    }
    if !legacy.is_empty() {
        let separator = if !admitted.is_empty() || !retained_legacy.is_empty() {
            "\n\n"
        } else {
            ""
        };
        if bytes + separator.len() + legacy.len() < MAX_BYTES {
            retained_legacy.insert(0, legacy);
        }
    }
    admitted.extend(retained_legacy);
    CompactedCache {
        body: serialize_blocks(&admitted),
        audit: if audit.is_empty() {
            String::new()
        } else {
            format!("{}\n", audit.join("\n\n"))
        },
    }
}

pub(in crate::cognition) fn contains_secret(value: &str) -> bool {
    static SECRET: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    SECRET
        .get_or_init(|| {
            fixed_regex(r"(?i)-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b|\bAKIA[0-9A-Z]{16}\b|\b(?:password|passwd|token|api[_ -]?key)\s*[:=]\s*[^\s]{8,}")
        })
        .is_match(value)
}

fn semantic_blocks(body: &str) -> Vec<(usize, usize)> {
    let mut blocks = Vec::new();
    let mut search = 0;
    while let Some(start_rel) = body[search..].find(SEMANTIC_PREFIX) {
        let start = search + start_rel;
        let id_start = start + SEMANTIC_PREFIX.len();
        let Some(start_end_rel) = body[id_start..].find(":start -->") else {
            search = id_start;
            continue;
        };
        let id_end = id_start + start_end_rel;
        let id = &body[id_start..id_end];
        if id.is_empty() || id.contains(':') || id.contains('>') {
            search = id_end;
            continue;
        }
        let end_marker = format!("<!-- butler-semantic:{id}:end -->");
        let content_start = id_end + ":start -->".len();
        let Some(end_rel) = body[content_start..].find(&end_marker) else {
            search = content_start;
            continue;
        };
        let mut end = content_start + end_rel + end_marker.len();
        if body[end..].starts_with('\n') {
            end += 1;
        }
        blocks.push((start, end));
        search = end;
    }
    blocks
}

fn parse_entry(block: &str) -> Option<Entry> {
    let start = block.find(ENTRY_PREFIX)? + ENTRY_PREFIX.len();
    let end = block[start..].find("\n-->")? + start;
    let value: Value = serde_json::from_str(&block[start..end]).ok()?;
    let text = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
    };
    text("episode_id")?;
    text("source_revision")?;
    text("summary")?;
    Some(Entry {
        id: text("entry_id")?.to_owned(),
        source_time: text("source_time").unwrap_or_default().to_owned(),
        salience: text("salience").unwrap_or("unspecified").to_owned(),
        valid_until: text("valid_until").map(str::to_owned),
    })
}

fn expired(value: Option<&str>) -> bool {
    value
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .is_some_and(|value| value.timestamp_millis() <= chrono::Utc::now().timestamp_millis())
}

fn salience_rank(value: &str) -> u8 {
    match value {
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
