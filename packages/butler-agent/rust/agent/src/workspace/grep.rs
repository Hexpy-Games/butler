//! Bounded regular-file reads and source-shaped per-line search.

use std::io::Read;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use regress::Regex;
use serde::Serialize;

const MATCH_TEXT_BYTES: usize = 16_384;

#[derive(Clone, Serialize)]
pub(crate) struct GrepLine {
    pub line: usize,
    pub text: String,
}

#[derive(Clone, Serialize)]
pub(crate) struct GrepMatch {
    pub path: String,
    pub line: usize,
    pub text: String,
    pub context: Vec<GrepLine>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload_truncated: Option<bool>,
}

pub(crate) struct GrepCandidate {
    pub root: PathBuf,
    pub path: String,
    pub bytes: u64,
    pub matcher: Arc<Regex>,
    pub context_lines: usize,
    pub max_bytes_per_file: usize,
    pub max_matches: usize,
    pub max_output_bytes: usize,
    pub after_line: Option<usize>,
    pub deadline: Instant,
}

pub(crate) struct GrepRead {
    pub skipped: bool,
    pub reason: Option<&'static str>,
    pub matches: Vec<GrepMatch>,
    pub bytes_read: usize,
    pub attempted_read: bool,
    pub within_file_truncated: bool,
}

impl GrepRead {
    fn skipped(reason: &'static str, bytes_read: usize, attempted_read: bool) -> Self {
        Self {
            skipped: true,
            reason: Some(reason),
            matches: Vec::new(),
            bytes_read,
            attempted_read,
            within_file_truncated: false,
        }
    }
}

fn prefix(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let mut end = 0;
    for (offset, character) in text.char_indices() {
        if offset + character.len_utf8() > max_bytes {
            break;
        }
        end = offset + character.len_utf8();
    }
    &text[..end]
}

fn matches_line(matcher: &Regex, line: &str, units: &mut Vec<u16>) -> bool {
    units.clear();
    units.extend(line.encode_utf16());
    matcher.find_from_ucs2(units, 0).next().is_some()
}

pub(super) fn read_candidate(input: &GrepCandidate) -> GrepRead {
    if Instant::now() >= input.deadline {
        return GrepRead::skipped("elapsed_ms", 0, false);
    }
    if input.bytes > input.max_bytes_per_file as u64 {
        return GrepRead::skipped("max_bytes_per_file", 0, false);
    }
    let absolute = input.root.join(&input.path);
    match std::fs::symlink_metadata(&absolute) {
        Ok(metadata) if !metadata.is_file() => return GrepRead::skipped("symlink", 0, false),
        Ok(metadata) if metadata.len() > input.max_bytes_per_file as u64 => {
            return GrepRead::skipped("max_bytes_per_file", 0, false);
        }
        Ok(_) => {}
        Err(_) => return GrepRead::skipped("io_error", 0, true),
    }
    if Instant::now() >= input.deadline {
        return GrepRead::skipped("elapsed_ms", 0, false);
    }
    let Ok(file) = std::fs::File::open(&absolute) else {
        return GrepRead::skipped("io_error", 0, true);
    };
    // A file can grow after lstat. Bound the native allocation at the declared cap.
    let mut bytes = Vec::new();
    if file
        .take(input.max_bytes_per_file as u64 + 1)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return GrepRead::skipped("io_error", 0, true);
    }
    let bytes_read = bytes.len();
    if Instant::now() >= input.deadline {
        return GrepRead::skipped("elapsed_ms", bytes_read, true);
    }
    if bytes_read > input.max_bytes_per_file {
        return GrepRead::skipped("max_bytes_per_file", bytes_read, true);
    }
    if bytes.iter().take(4096).any(|byte| *byte == 0) {
        return GrepRead::skipped("binary", bytes_read, true);
    }
    let Ok(decoded) = std::str::from_utf8(&bytes) else {
        return GrepRead::skipped("invalid_utf8", bytes_read, true);
    };
    let normalized = if decoded.contains('\r') {
        std::borrow::Cow::Owned(decoded.replace("\r\n", "\n").replace('\r', "\n"))
    } else {
        std::borrow::Cow::Borrowed(decoded)
    };
    let lines: Vec<&str> = normalized.split('\n').collect();
    let mut units = Vec::new();
    let mut matches = Vec::new();
    let mut match_bytes = 0usize;
    let candidate_budget = input
        .max_output_bytes
        .saturating_add(MATCH_TEXT_BYTES.saturating_mul(input.context_lines + 1));
    for (index, line) in lines.iter().enumerate() {
        if !matches_line(&input.matcher, line, &mut units) {
            continue;
        }
        if input.after_line.is_some_and(|after| index < after) {
            continue;
        }
        let start = index.saturating_sub(input.context_lines);
        let end = (index + input.context_lines).min(lines.len() - 1);
        let text = prefix(line, MATCH_TEXT_BYTES).to_owned();
        let context: Vec<_> = (start..=end)
            .map(|offset| GrepLine {
                line: offset + 1,
                text: prefix(lines[offset], MATCH_TEXT_BYTES).to_owned(),
            })
            .collect();
        match_bytes += text.len() + context.iter().map(|line| line.text.len()).sum::<usize>();
        matches.push(GrepMatch {
            path: input.path.clone(),
            line: index + 1,
            text,
            context,
            payload_truncated: None,
        });
        if matches.len() >= input.max_matches || match_bytes >= candidate_budget {
            let later = lines[index + 1..]
                .iter()
                .any(|line| matches_line(&input.matcher, line, &mut units));
            return GrepRead {
                skipped: false,
                reason: None,
                matches,
                bytes_read,
                attempted_read: true,
                within_file_truncated: later,
            };
        }
    }
    GrepRead {
        skipped: false,
        reason: None,
        matches,
        bytes_read,
        attempted_read: true,
        within_file_truncated: false,
    }
}
