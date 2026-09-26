use crate::public_text::fixed_regex;
use std::{
    collections::HashSet,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
    sync::OnceLock,
};

use regex::Regex;
use serde_json::Value;

use crate::json_lines::MAX_JSON_LINE_BYTES;
use crate::public_text::trim_js_whitespace;

const MAX_SKILL_NAMES: usize = 48;

pub(super) fn loaded_names(data: &Path, session: &str, turn: Option<&str>) -> Option<Vec<String>> {
    let safe: String = session
        .encode_utf16()
        .map(|unit| match u8::try_from(unit) {
            Ok(byte) if byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-') => {
                char::from(byte)
            }
            _ => '_',
        })
        .collect();
    let path = data.join("transcripts").join(format!("{safe}.jsonl"));
    latest_names(&path, turn)
}

fn latest_names(path: &Path, turn: Option<&str>) -> Option<Vec<String>> {
    let mut file = File::open(path).ok()?;
    let mut remaining = file.metadata().ok()?.len();
    let mut reversed = Vec::new();
    let mut oversize = false;
    let mut ended_with_newline = false;
    let mut chunk = vec![0_u8; 32 * 1024];
    while remaining > 0 {
        let count = usize::try_from(remaining.min(chunk.len() as u64)).unwrap_or(usize::MAX);
        remaining -= count as u64;
        file.seek(SeekFrom::Start(remaining)).ok()?;
        file.read_exact(&mut chunk[..count]).ok()?;
        for byte in chunk[..count].iter().rev() {
            if *byte == b'\n' {
                if !oversize && let Some(names) = names_from_reversed(&reversed, turn) {
                    return Some(names);
                }
                reversed.clear();
                oversize = false;
                ended_with_newline = true;
            } else if !oversize {
                let limit = MAX_JSON_LINE_BYTES - usize::from(ended_with_newline);
                if reversed.len() < limit {
                    reversed.push(*byte);
                } else {
                    reversed.clear();
                    oversize = true;
                }
            }
        }
    }
    (!oversize)
        .then(|| names_from_reversed(&reversed, turn))
        .flatten()
}

fn names_from_reversed(reversed: &[u8], turn: Option<&str>) -> Option<Vec<String>> {
    let value =
        serde_json::from_slice::<Value>(&reversed.iter().rev().copied().collect::<Vec<_>>())
            .ok()?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_latest_matching_skill_names_from_file_tail() {
        let path = std::env::temp_dir().join(format!("butler-skill-tail-{}", uuid::Uuid::new_v4()));
        let rows = [
            r#"{"kind":"system","payload":{"category":"context.skills.loaded","details":{"turnId":"t","skillNames":["old"]}}}"#,
            r#"{"kind":"outbound","payload":{"metadata":{"kind":"final_result","turnId":"t","loadedSkillNames":["new"]}}}"#,
            r#"{"kind":"outbound","payload":{"metadata":{"kind":"final_result","turnId":"other","loadedSkillNames":["wrong"]}}}"#,
            "not-json",
        ];
        std::fs::write(&path, rows.join("\n")).unwrap();
        assert_eq!(latest_names(&path, Some("t")), Some(vec!["new".to_owned()]));
        let _ = std::fs::remove_file(path);
    }
}
