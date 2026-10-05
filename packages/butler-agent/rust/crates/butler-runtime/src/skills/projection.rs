use butler_core::public_text::fixed_regex;
use std::{
    collections::HashSet,
    fs::File,
    io::{Read, Seek, SeekFrom},
    sync::OnceLock,
};

use regex::Regex;
use serde_json::Value;

use butler_core::json_lines::MAX_JSON_LINE_BYTES;
use butler_core::public_text::trim_js_whitespace;

const MAX_SKILL_NAMES: usize = 48;

pub(super) fn latest_names_since(
    file: &mut File,
    length: u64,
    turn: Option<&str>,
    cutoff: u64,
) -> Option<(Option<Vec<String>>, u64)> {
    let mut remaining = length;
    let mut boundary = cutoff;
    let mut fragments = Fragments::default();
    let mut ended_with_newline = false;
    let capacity = length.saturating_sub(cutoff).clamp(1, 32 * 1024) as usize;
    let mut chunk = vec![0_u8; capacity];
    while remaining > cutoff {
        let count =
            usize::try_from((remaining - cutoff).min(chunk.len() as u64)).unwrap_or(usize::MAX);
        remaining -= count as u64;
        file.seek(SeekFrom::Start(remaining)).ok()?;
        file.read_exact(&mut chunk[..count]).ok()?;
        let mut end = count;
        while let Some(newline) = memchr::memrchr(b'\n', &chunk[..end]) {
            boundary = boundary.max(remaining + newline as u64 + 1);
            let limit = MAX_JSON_LINE_BYTES - usize::from(ended_with_newline);
            if let Some(names) = fragments.names(&chunk[newline + 1..end], limit, turn) {
                return Some((Some(names), boundary));
            }
            fragments = Fragments::default();
            ended_with_newline = true;
            end = newline;
        }
        fragments.push(
            &chunk[..end],
            MAX_JSON_LINE_BYTES - usize::from(ended_with_newline),
        );
    }
    let names = fragments.names(
        &[],
        MAX_JSON_LINE_BYTES - usize::from(ended_with_newline),
        turn,
    );
    Some((names, boundary))
}

#[derive(Default)]
struct Fragments {
    segments: Vec<Vec<u8>>,
    length: usize,
    oversize: bool,
}
impl Fragments {
    fn push(&mut self, bytes: &[u8], limit: usize) {
        self.length = self.length.saturating_add(bytes.len());
        if self.length > limit {
            self.oversize = true;
            self.segments.clear();
        } else if !self.oversize && !bytes.is_empty() {
            self.segments.push(bytes.to_vec());
        }
    }
    fn names(&mut self, prefix: &[u8], limit: usize, turn: Option<&str>) -> Option<Vec<String>> {
        if self.oversize || self.length.saturating_add(prefix.len()) > limit {
            return None;
        }
        // Most records fit inside the read block. Borrow them directly rather
        // than reversing and allocating every byte of every unrelated record.
        if self.segments.is_empty() {
            return names_from_record(prefix, turn);
        }
        let mut record = Vec::with_capacity(self.length + prefix.len());
        record.extend_from_slice(prefix);
        for segment in self.segments.iter().rev() {
            record.extend_from_slice(segment);
        }
        names_from_record(&record, turn)
    }
}

fn names_from_record(record: &[u8], turn: Option<&str>) -> Option<Vec<String>> {
    // Escaped category names must still take the complete JSON path.
    if memchr::memmem::find(record, b"skills").is_none()
        && memchr::memmem::find(record, b"final_result").is_none()
        && memchr::memmem::find(record, b"\\u").is_none()
    {
        return None;
    }
    let value = serde_json::from_slice::<Value>(record).ok()?;
    event_names(&value, turn)
}

fn event_names(event: &Value, turn: Option<&str>) -> Option<Vec<String>> {
    let kind = event.get("kind")?.as_str()?;
    let payload = event.get("payload")?;
    let names = if kind == "outbound" {
        let metadata = payload.get("metadata")?;
        if metadata.get("kind")?.as_str()? != "final_result" || !turn_matches(metadata, turn) {
            return None;
        }
        metadata.get("loadedSkillNames").unwrap_or(&Value::Null)
    } else if kind == "system"
        && payload.get("category").and_then(Value::as_str) == Some("context.skills.loaded")
    {
        let details = payload.get("details")?;
        let event_turn = details
            .get("turnId")
            .and_then(Value::as_str)
            .or_else(|| event.get("metadata")?.get("turnId")?.as_str());
        if turn.is_some() && event_turn != turn {
            return None;
        }
        details.get("skillNames").unwrap_or(&Value::Null)
    } else {
        return None;
    };
    let mut seen = HashSet::new();
    let mut safe = Vec::new();
    for value in names.as_array().into_iter().flatten() {
        let Some(name) = safe_short_token(value) else {
            continue;
        };
        if seen.insert(name.clone()) {
            safe.push(name);
            if safe.len() == MAX_SKILL_NAMES {
                break;
            }
        }
    }
    Some(safe)
}

fn safe_short_token(value: &Value) -> Option<String> {
    static TOKEN: OnceLock<Regex> = OnceLock::new();
    let text = trim_js_whitespace(value.as_str()?);
    if text.is_empty()
        || !TOKEN
            .get_or_init(|| fixed_regex(r"^[A-Za-z0-9_:./-]+$"))
            .is_match(text)
    {
        return None;
    }
    Some(text.chars().take(96).collect())
}

fn turn_matches(metadata: &Value, turn: Option<&str>) -> bool {
    turn.is_none() || metadata.get("turnId").and_then(Value::as_str) == turn
}
