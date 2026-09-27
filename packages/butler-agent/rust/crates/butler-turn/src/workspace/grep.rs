//! Bounded regular-file reads and source-shaped per-line search.

use std::io::Read;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use regress::Regex;
use serde::Serialize;

const MATCH_TEXT_BYTES: usize = 16_384;

#[derive(Clone, Serialize)]
pub struct GrepLine {
    pub line: usize,
    pub text: String,
}

/// A matching line with its context.
#[derive(Clone, Serialize)]
pub struct GrepMatch {
    pub path: String,
    pub line: usize,
    pub text: String,
    pub context: Vec<GrepLine>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload_truncated: Option<bool>,
}

/// A listed file to search within deadline and budgets.
pub struct GrepCandidate {
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

/// A candidate's matches, or why it was skipped.
pub struct GrepRead {
    pub skipped: bool,
    pub reason: Option<&'static str>,
    pub matches: Vec<GrepMatch>,
    pub bytes_read: usize,
    pub attempted_read: bool,
    pub within_file_truncated: bool,
}

impl GrepRead {
    /// Skipped before a read was attempted.
    fn skipped_unread(reason: &'static str) -> Self {
        Self {
            attempted_read: false,
            ..Self::skipped_after_read(reason, 0)
        }
    }

    /// Skipped after a read was attempted (a failed read has no bytes).
    fn skipped_after_read(reason: &'static str, bytes_read: usize) -> Self {
        Self {
            skipped: true,
            reason: Some(reason),
            matches: Vec::new(),
            bytes_read,
            attempted_read: true,
            within_file_truncated: false,
        }
    }
}

fn prefix(text: &str, max_bytes: usize) -> &str {
    let end = crate::workspace::files::utf8_prefix_end(text, max_bytes);
    text.get(..end).unwrap_or_default()
}

fn matches_line(matcher: &Regex, line: &str, units: &mut Vec<u16>) -> bool {
    units.clear();
    units.extend(line.encode_utf16());
    matcher.find_from_ucs2(units, 0).next().is_some()
}

/// Reads one listed candidate within the deadline and byte cap and returns
/// its matching lines with context.
pub(super) fn read_candidate(input: &GrepCandidate) -> GrepRead {
    let bytes = match read_bounded(input) {
        Ok(bytes) => bytes,
        Err(skipped) => return skipped,
    };
    let bytes_read = bytes.len();
    if bytes.iter().take(4096).any(|byte| *byte == 0) {
        return GrepRead::skipped_after_read("binary", bytes_read);
    }
    let Ok(decoded) = std::str::from_utf8(&bytes) else {
        return GrepRead::skipped_after_read("invalid_utf8", bytes_read);
    };
    let normalized = if decoded.contains('\r') {
        std::borrow::Cow::Owned(decoded.replace("\r\n", "\n").replace('\r', "\n"))
    } else {
        std::borrow::Cow::Borrowed(decoded)
    };
    search_lines(input, &normalized, bytes_read)
}

/// The candidate's bytes, re-checking type, size and deadline around the
/// read; a file that grew past the cap after `lstat` is refused.
fn read_bounded(input: &GrepCandidate) -> Result<Vec<u8>, GrepRead> {
    if Instant::now() >= input.deadline {
        return Err(GrepRead::skipped_unread("elapsed_ms"));
    }
    let cap = input.max_bytes_per_file as u64;
    if input.bytes > cap {
        return Err(GrepRead::skipped_unread("max_bytes_per_file"));
    }
    let absolute = input.root.join(&input.path);
    match std::fs::symlink_metadata(&absolute) {
        Ok(metadata) if !metadata.is_file() => return Err(GrepRead::skipped_unread("symlink")),
        Ok(metadata) if metadata.len() > cap => {
            return Err(GrepRead::skipped_unread("max_bytes_per_file"));
        }
        Ok(_) => {}
        Err(_) => return Err(GrepRead::skipped_after_read("io_error", 0)),
    }
    if Instant::now() >= input.deadline {
        return Err(GrepRead::skipped_unread("elapsed_ms"));
    }
    let Ok(file) = std::fs::File::open(&absolute) else {
        return Err(GrepRead::skipped_after_read("io_error", 0));
    };
    // A file can grow after lstat. Bound the native allocation at the declared cap.
    let mut bytes = Vec::new();
    if file.take(cap + 1).read_to_end(&mut bytes).is_err() {
        return Err(GrepRead::skipped_after_read("io_error", 0));
    }
    if Instant::now() >= input.deadline {
        return Err(GrepRead::skipped_after_read("elapsed_ms", bytes.len()));
    }
    if bytes.len() > input.max_bytes_per_file {
        return Err(GrepRead::skipped_after_read(
            "max_bytes_per_file",
            bytes.len(),
        ));
    }
    Ok(bytes)
}

/// Collects matching lines with their context until the match count or the
/// output budget is reached, noting whether later lines would match too.
fn search_lines(input: &GrepCandidate, text: &str, bytes_read: usize) -> GrepRead {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut units = Vec::new();
    let mut matches = Vec::new();
    let mut match_bytes = 0usize;
    let candidate_budget = input
        .max_output_bytes
        .saturating_add(MATCH_TEXT_BYTES.saturating_mul(input.context_lines + 1));
    let mut within_file_truncated = false;
    for (index, line) in lines.iter().enumerate() {
        if !matches_line(&input.matcher, line, &mut units)
            || input.after_line.is_some_and(|after| index < after)
        {
            continue;
        }
        let start = index.saturating_sub(input.context_lines);
        let end = (index + input.context_lines).min(lines.len() - 1);
        let text = prefix(line, MATCH_TEXT_BYTES).to_owned();
        let context: Vec<_> = lines
            .iter()
            .enumerate()
            .take(end + 1)
            .skip(start)
            .map(|(offset, line)| GrepLine {
                line: offset + 1,
                text: prefix(line, MATCH_TEXT_BYTES).to_owned(),
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
            within_file_truncated = lines
                .iter()
                .skip(index + 1)
                .any(|line| matches_line(&input.matcher, line, &mut units));
            break;
        }
    }
    GrepRead {
        skipped: false,
        reason: None,
        matches,
        bytes_read,
        attempted_read: true,
        within_file_truncated,
    }
}
