use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use regress::Regex;

use crate::workspace::{
    GrepCandidate, GrepMatch, GrepRead, NativeWorkspaceFiles, WorkspaceListEntry,
    WorkspaceListResult,
};

pub(super) struct CandidateResult {
    pub path: String,
    pub read: GrepRead,
}

pub(super) struct SearchResult {
    pub matches: Vec<GrepMatch>,
    pub reads: Vec<CandidateResult>,
    pub output_bytes: usize,
    pub max_matches_reached: bool,
    pub max_output_reached: bool,
    pub stopped_within_candidate: bool,
    pub elapsed_budget_reached: bool,
    pub window_start: Option<String>,
    pub window_end: Option<String>,
    pub processed_candidate: Option<String>,
}

pub(super) fn priority(path: &str) -> u8 {
    let segments: Vec<_> = path.split('/').collect();
    if segments.contains(&"src") {
        return 0;
    }
    if segments
        .iter()
        .any(|segment| ["test", "tests", "fixture", "fixtures"].contains(segment))
        || path
            .rsplit('/')
            .next()
            .is_some_and(|name| name.contains(".spec.") || name.contains(".test."))
    {
        return 3;
    }
    if segments
        .iter()
        .any(|segment| ["example", "examples", "scripts"].contains(segment))
    {
        return 2;
    }
    1
}

fn compare_paths(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn compare_search(left: &str, right: &str) -> std::cmp::Ordering {
    priority(left)
        .cmp(&priority(right))
        .then_with(|| compare_paths(left, right))
}

pub(super) fn fit(mut item: GrepMatch, available: usize) -> (GrepMatch, usize, bool) {
    let mut remaining = available;
    let text_end = super::utf8_prefix_end(&item.text, remaining);
    let mut truncated = text_end < item.text.len();
    item.text.truncate(text_end);
    remaining -= item.text.len();
    let original_context_len = item.context.len();
    let mut context = Vec::with_capacity(original_context_len);
    for mut line in item.context {
        if remaining == 0 {
            truncated = true;
            break;
        }
        let end = super::utf8_prefix_end(&line.text, remaining);
        let line_truncated = end < line.text.len();
        truncated |= line_truncated;
        line.text.truncate(end);
        remaining -= line.text.len();
        context.push(line);
        if line_truncated {
            break;
        }
    }
    truncated |= context.len() < original_context_len;
    item.context = context;
    if truncated {
        item.payload_truncated = Some(true);
    }
    (item, available - remaining, truncated)
}

pub(super) async fn execute(
    owner: &NativeWorkspaceFiles,
    root: PathBuf,
    listed: &WorkspaceListResult,
    matcher: Arc<Regex>,
    options: &super::args::Options,
    cursor: Option<&super::cursor::GrepCursor>,
    deadline: Instant,
) -> Result<SearchResult, super::super::CapabilityError> {
    let mut lexical: Vec<&WorkspaceListEntry> = listed.files.iter().collect();
    lexical.sort_by(|left, right| compare_paths(&left.path, &right.path));
    let window_start = cursor
        .and_then(|cursor| cursor.window_start.clone())
        .or_else(|| lexical.first().map(|entry| entry.path.clone()));
    let window_end = cursor
        .and_then(|cursor| cursor.window_end.clone())
        .or_else(|| lexical.last().map(|entry| entry.path.clone()));
    let mut candidates: Vec<&WorkspaceListEntry> = lexical
        .into_iter()
        .filter(|entry| {
            window_end
                .as_deref()
                .is_none_or(|end| compare_paths(&entry.path, end).is_le())
        })
        .collect();
    candidates.sort_by(|left, right| compare_search(&left.path, &right.path));
    let after = cursor.and_then(|cursor| cursor.marker.as_deref().zip(cursor.line));
    if let Some((path, _)) = after {
        candidates.retain(|entry| !compare_search(&entry.path, path).is_lt());
    }
    let mut result = SearchResult {
        matches: Vec::new(),
        reads: Vec::new(),
        output_bytes: 0,
        max_matches_reached: false,
        max_output_reached: false,
        stopped_within_candidate: false,
        elapsed_budget_reached: listed.stopped_by == Some("elapsed_ms")
            || Instant::now() >= deadline,
        window_start,
        window_end,
        processed_candidate: None,
    };
    'batches: for (offset, batch) in candidates.chunks(4).enumerate() {
        if result.elapsed_budget_reached || Instant::now() >= deadline {
            result.elapsed_budget_reached = true;
            break;
        }
        let reads = futures_util::future::join_all(batch.iter().map(|entry| {
            owner.grep_candidate(GrepCandidate {
                root: root.clone(),
                path: entry.path.clone(),
                bytes: entry.bytes,
                matcher: Arc::clone(&matcher),
                context_lines: options.context_lines,
                max_bytes_per_file: options.max_bytes_per_file,
                max_matches: options.max_matches,
                max_output_bytes: options.max_output_bytes,
                after_line: after.and_then(|(path, line)| (path == entry.path).then_some(line)),
                deadline,
            })
        }))
        .await;
        for (entry, read) in batch.iter().zip(reads) {
            result.reads.push(CandidateResult {
                path: entry.path.clone(),
                read: read.map_err(|error| super::super::CapabilityError {
                    code: error.code.into(),
                })?,
            });
        }
        let base = offset * 4;
        for (index, candidate) in result.reads[base..].iter().enumerate() {
            for item in &candidate.read.matches {
                if let Some((path, line)) = after {
                    let order = compare_search(&item.path, path).then_with(|| item.line.cmp(&line));
                    if !order.is_gt() {
                        continue;
                    }
                }
                let has_later = base + index < candidates.len() - 1;
                if result.matches.len() >= options.max_matches {
                    result.max_matches_reached = true;
                    result.stopped_within_candidate =
                        candidate.read.within_file_truncated || has_later;
                    break 'batches;
                }
                let (fitted, bytes, truncated) =
                    fit(item.clone(), options.max_output_bytes - result.output_bytes);
                result.matches.push(fitted);
                result.output_bytes += bytes;
                if truncated || result.output_bytes >= options.max_output_bytes {
                    result.max_output_reached = true;
                    result.stopped_within_candidate = true;
                    break 'batches;
                }
                if result.matches.len() >= options.max_matches {
                    result.max_matches_reached = true;
                    result.stopped_within_candidate =
                        candidate.read.within_file_truncated || has_later;
                    break 'batches;
                }
            }
            if candidate.read.within_file_truncated {
                result.stopped_within_candidate = true;
                break 'batches;
            }
        }
        if result.reads[base..]
            .iter()
            .any(|candidate| candidate.read.reason == Some("elapsed_ms"))
            || Instant::now() >= deadline
        {
            result.elapsed_budget_reached = true;
            break;
        }
    }
    result.processed_candidate = result
        .reads
        .len()
        .checked_sub(1)
        .and_then(|index| candidates.get(index))
        .map(|entry| entry.path.clone());
    Ok(result)
}
