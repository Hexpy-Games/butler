//! Source compactHotCache ordering for unstructured save_hot entries.

use chrono::{DateTime, Utc};
use serde_json::Value;

struct Block<'a> {
    body: &'a str,
    entry: Option<Value>,
}

pub(super) fn compact(raw: &str, max_bytes: usize) -> String {
    let (legacy, blocks) = parse_blocks(raw);
    let now: DateTime<Utc> = std::time::SystemTime::now().into();
    // Structured blocks that are still valid, as (body, entry).
    let mut structured: Vec<(&str, &Value)> = blocks
        .iter()
        .filter_map(|block| {
            let entry = block.entry.as_ref()?;
            let valid = entry
                .get("valid_until")
                .and_then(Value::as_str)
                .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
                .is_none_or(|until| until.with_timezone(&Utc) > now);
            valid.then_some((block.body, entry))
        })
        .collect();
    structured.sort_by(|(_, l), (_, r)| {
        rank(l)
            .cmp(&rank(r))
            .then_with(|| string(r, "source_time").cmp(string(l, "source_time")))
            .then_with(|| string(l, "entry_id").cmp(string(r, "entry_id")))
    });
    let mut admitted: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (body, entry) in structured {
        let entry_id = string(entry, "entry_id");
        if !seen.insert(entry_id.to_owned()) {
            continue;
        }
        let body = body.trim_end();
        let candidate = serialize(
            admitted
                .iter()
                .map(String::as_str)
                .chain(std::iter::once(body)),
        );
        if candidate.len() <= max_bytes {
            admitted.push(body.to_owned());
        }
    }
    let mut bytes = serialize(admitted.iter().map(String::as_str)).len();
    let mut retained: Vec<String> = Vec::new();
    for block in blocks.iter().rev().filter(|block| block.entry.is_none()) {
        let body = block.body.trim_end();
        let separator = if admitted.is_empty() && retained.is_empty() {
            ""
        } else {
            "\n\n"
        };
        let cost = separator.len() + body.len() + 1;
        if bytes + cost <= max_bytes {
            retained.insert(0, body.to_owned());
            bytes += cost;
        }
    }
    let legacy = legacy.trim();
    if !legacy.is_empty() {
        let separator = if admitted.is_empty() && retained.is_empty() {
            ""
        } else {
            "\n\n"
        };
        if bytes + separator.len() + legacy.len() < max_bytes {
            retained.insert(0, legacy.to_owned());
        }
    }
    admitted.extend(retained);
    serialize(admitted.iter().map(String::as_str))
}

fn rank(value: &Value) -> u8 {
    match string(value, "salience") {
        "high" => 0,
        "normal" => 1,
        _ => 2,
    }
}

fn string<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or("")
}

fn serialize<'a>(blocks: impl Iterator<Item = &'a str>) -> String {
    let joined = blocks.collect::<Vec<_>>().join("\n\n");
    if joined.is_empty() {
        joined
    } else {
        format!("{joined}\n")
    }
}

fn parse_blocks(raw: &str) -> (String, Vec<Block<'_>>) {
    let mut legacy = String::new();
    let mut blocks = Vec::new();
    let mut cursor = 0;
    const START: &str = "<!-- butler-semantic:";
    while let Some(relative) = raw[cursor..].find(START) {
        let start = cursor + relative;
        legacy.push_str(&raw[cursor..start]);
        let id_start = start + START.len();
        let Some(id_end_relative) = raw[id_start..].find(":start -->") else {
            break;
        };
        let id_end = id_start + id_end_relative;
        let id = &raw[id_start..id_end];
        if id.is_empty() || id.contains(':') || id.contains('>') {
            cursor = id_end + 1;
            continue;
        }
        let end_marker = format!("<!-- butler-semantic:{id}:end -->");
        let content_start = id_end + ":start -->".len();
        let Some(end_relative) = raw[content_start..].find(&end_marker) else {
            break;
        };
        let mut end = content_start + end_relative + end_marker.len();
        if raw.as_bytes().get(end) == Some(&b'\n') {
            end += 1;
        }
        let body = &raw[start..end];
        blocks.push(Block {
            body,
            entry: parse_entry(body),
        });
        cursor = end;
    }
    legacy.push_str(&raw[cursor..]);
    (legacy, blocks)
}

fn parse_entry(body: &str) -> Option<Value> {
    let start =
        body.find("<!-- butler-hot-cache-entry:v2\n")? + "<!-- butler-hot-cache-entry:v2\n".len();
    let end = body[start..].find("\n-->")? + start;
    let entry: Value = serde_json::from_str(&body[start..end]).ok()?;
    for field in ["entry_id", "episode_id", "source_revision", "summary"] {
        if string(&entry, field).is_empty() {
            return None;
        }
    }
    Some(entry)
}

#[cfg(test)]
mod tests {
    use super::compact;
    #[test]
    fn retains_recent_legacy_blocks_at_source_budget() {
        let older = format!(
            "<!-- butler-semantic:old:start -->\n{}\n<!-- butler-semantic:old:end -->\n",
            "x".repeat(40)
        );
        let recent = "<!-- butler-semantic:new:start -->\nnew\n<!-- butler-semantic:new:end -->\n";
        let result = compact(&format!("{older}\n{recent}"), recent.len() + 2);
        assert!(result.contains("new"));
        assert!(!result.contains("old"));
    }
}
