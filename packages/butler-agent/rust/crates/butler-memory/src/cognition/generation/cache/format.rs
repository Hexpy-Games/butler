//! Pure formatting and compaction for structured generation hot-cache entries.

use super::receipt::ExclusionReason;
use crate::cognition::{CognitionCode, CognitionError};
use butler_core::public_text::fixed_regex;
use std::{collections::HashSet, sync::OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use butler_core::public_text::{trim_js_whitespace, trim_js_whitespace_end};
mod blocks;
use blocks::{
    ParsedBlock, append_block, is_expired, parse_structured_entry, render_entry_block,
    safe_marker_id, scan_semantic_blocks, serialize_blocks, validate_candidate,
};

const DEFAULT_MAX_BYTES: usize = 20 * 1024;
const MAX_ENTRY_BODY_UTF16: usize = 8_000;
const SEMANTIC_PREFIX: &str = "<!-- butler-semantic:";
const STRUCTURED_PREFIX: &str = "<!-- butler-hot-cache-entry:v2\n";

/// Every well-formed structured entry in a cache body, in file order.
pub(in crate::cognition) fn physical_entries(body: &str) -> Vec<HotCacheEntryView> {
    scan_semantic_blocks(body)
        .into_iter()
        .filter_map(|block| {
            let text = body.get(block.start..block.end)?;
            parse_structured_entry(text)?;
            let value: Value = serde_json::from_str(structured_metadata(text)?).ok()?;
            value
                .is_object()
                .then(|| HotCacheEntryView::deserialize(&value).ok())
                .flatten()
        })
        .collect()
}

/// The JSON metadata of a structured entry block.
fn structured_metadata(block: &str) -> Option<&str> {
    let start = block.find(STRUCTURED_PREFIX)? + STRUCTURED_PREFIX.len();
    let rest = block.get(start..)?;
    rest.get(..rest.find("\n-->")?)
}

/// Lenient view of an entry's stored metadata, as every validator reads it:
/// a field of the wrong type reads as absent.
#[derive(Clone, Debug, Default, Deserialize)]
pub(in crate::cognition) struct HotCacheEntryView {
    #[serde(default, deserialize_with = "crate::lenient::option")]
    pub entry_id: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    pub episode_id: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    pub window_ref: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    pub node_refs: Option<Vec<String>>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    pub source_revision: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    pub valid_until: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    pub summary: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    pub scope: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    pub project_id: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    pub session_id: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    pub graph_revision: Option<i64>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    pub source_refs: Option<Vec<String>>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    pub authority: Option<String>,
    #[serde(default, deserialize_with = "crate::lenient::option")]
    pub source_class: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct ExcludedEntry {
    pub(super) id: String,
    pub(super) reason: ExclusionReason,
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
    new_entry: Option<&SourceBackedHotCacheEntry>,
    valid_entry_ids: &HashSet<String>,
    now_epoch_ms: i64,
) -> Result<RenderedCache, CognitionError> {
    let candidate = new_entry.cloned().map(validate_candidate).transpose()?;
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
    let sorted = partition_blocks(&staged, valid_entry_ids, now_epoch_ms);
    let admitted = admit_within_budget(sorted.valid);
    let mut excluded = sorted.excluded;
    excluded.extend(admitted.excluded);
    let body = serialize_blocks(&admitted.blocks);
    let audit = if sorted.audit.is_empty() {
        String::new()
    } else {
        format!("{}\n", sorted.audit.join("\n\n"))
    };
    Ok(RenderedCache {
        compacted: body != staged,
        admitted: candidate_id.is_none_or(|id| admitted.ids.contains(&id)),
        replayed,
        body,
        audit,
        excluded,
    })
}

/// A staged cache split into audit text, excluded entries, and the valid
/// blocks in retention order.
struct Partitioned {
    audit: Vec<String>,
    excluded: Vec<ExcludedEntry>,
    valid: Vec<ParsedBlock>,
}

/// Separates legacy text and unparseable blocks (kept for audit), expired
/// and invalidated entries, and valid entries sorted by salience, recency,
/// then id, with duplicates dropped.
fn partition_blocks(
    staged: &str,
    valid_entry_ids: &HashSet<String>,
    now_epoch_ms: i64,
) -> Partitioned {
    let blocks = scan_semantic_blocks(staged);
    let mut legacy_parts = Vec::new();
    let mut cursor = 0;
    for block in &blocks {
        legacy_parts.push(staged.get(cursor..block.start).unwrap_or_default());
        cursor = block.end;
    }
    legacy_parts.push(staged.get(cursor..).unwrap_or_default());
    let joined_legacy = legacy_parts.concat();
    let legacy = trim_js_whitespace(&joined_legacy);
    let mut partitioned = Partitioned {
        audit: Vec::new(),
        excluded: Vec::new(),
        valid: Vec::new(),
    };
    if !legacy.is_empty() {
        partitioned.audit.push(legacy.to_owned());
    }
    for block in blocks {
        let body = staged.get(block.start..block.end).unwrap_or_default();
        let Some(entry) = parse_structured_entry(body) else {
            partitioned
                .audit
                .push(trim_js_whitespace_end(body).to_owned());
            continue;
        };
        let reason = if is_expired(entry.valid_until.as_deref(), now_epoch_ms) {
            Some(ExclusionReason::Expired)
        } else if !valid_entry_ids.contains(&entry.entry_id) {
            Some(ExclusionReason::Invalidated)
        } else {
            None
        };
        match reason {
            Some(reason) => partitioned.excluded.push(ExcludedEntry {
                id: entry.entry_id,
                reason,
            }),
            None => partitioned.valid.push(ParsedBlock {
                body: trim_js_whitespace_end(body).to_owned(),
                entry,
            }),
        }
    }
    partitioned.valid.sort_by(|left, right| {
        left.entry
            .salience
            .rank()
            .cmp(&right.entry.salience.rank())
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
    let mut seen = HashSet::new();
    partitioned
        .valid
        .retain(|block| seen.insert(block.entry.entry_id.clone()));
    partitioned
}

/// Blocks kept within the byte budget, in order.
struct Admitted {
    blocks: Vec<String>,
    ids: HashSet<String>,
    excluded: Vec<ExcludedEntry>,
}

/// Keeps blocks in order while the serialized cache fits the budget; a block
/// that alone exceeds it is oversized, one that no longer fits is over budget.
fn admit_within_budget(valid: Vec<ParsedBlock>) -> Admitted {
    let mut admitted = Admitted {
        blocks: Vec::new(),
        ids: HashSet::new(),
        excluded: Vec::new(),
    };
    for block in valid {
        let single_bytes = serialize_blocks(std::slice::from_ref(&block.body)).len();
        let mut candidate_blocks = admitted.blocks.clone();
        candidate_blocks.push(block.body.clone());
        if single_bytes > DEFAULT_MAX_BYTES {
            admitted.excluded.push(ExcludedEntry {
                id: block.entry.entry_id,
                reason: ExclusionReason::Oversized,
            });
        } else if serialize_blocks(&candidate_blocks).len() > DEFAULT_MAX_BYTES {
            admitted.excluded.push(ExcludedEntry {
                id: block.entry.entry_id,
                reason: ExclusionReason::Budget,
            });
        } else {
            admitted.ids.insert(block.entry.entry_id);
            admitted.blocks.push(block.body);
        }
    }
    admitted
}

/// One window summary as written into the cache file's entry metadata.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub(in crate::cognition) struct SourceBackedHotCacheEntry {
    pub entry_id: String,
    pub episode_id: String,
    pub window_ref: String,
    pub node_refs: Vec<String>,
    pub source_revision: String,
    pub source_time: String,
    #[serde(default)]
    pub valid_until: Option<String>,
    pub kind: String,
    pub summary: String,
    pub basis: Vec<String>,
    pub salience: Salience,
    pub scope: Scope,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_kind: Option<SourceKind>,
    pub graph_revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authority: Option<Authority>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_class: Option<SourceClass>,
    pub source_refs: Vec<String>,
}

impl SourceBackedHotCacheEntry {
    /// The validator view of this entry.
    pub(in crate::cognition) fn view(&self) -> HotCacheEntryView {
        HotCacheEntryView {
            entry_id: Some(self.entry_id.clone()),
            episode_id: Some(self.episode_id.clone()),
            window_ref: Some(self.window_ref.clone()),
            node_refs: Some(self.node_refs.clone()),
            source_revision: Some(self.source_revision.clone()),
            valid_until: self.valid_until.clone(),
            summary: Some(self.summary.clone()),
            scope: Some(self.scope.as_str().to_owned()),
            project_id: self.project_id.clone(),
            session_id: self.session_id.clone(),
            graph_revision: Some(self.graph_revision),
            source_refs: Some(self.source_refs.clone()),
            authority: self
                .authority
                .as_ref()
                .map(|_| "model_interpretation".to_owned()),
            source_class: self.source_class.map(|class| class.as_str().to_owned()),
        }
    }
}

/// How prominently an entry is kept when the cache is over budget.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(in crate::cognition) enum Salience {
    High,
    Normal,
    Unspecified,
}

impl Salience {
    fn rank(self) -> u8 {
        match self {
            Self::High => 0,
            Self::Normal => 1,
            Self::Unspecified => 2,
        }
    }
}

/// Whether an entry belongs to one project or every session.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(in crate::cognition) enum Scope {
    Project,
    Global,
}

impl Scope {
    fn as_str(self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::Global => "global",
        }
    }
}

/// The kind of source a summarized window came from.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(in crate::cognition) enum SourceKind {
    Conversation,
    TaskReport,
    ExplicitRecord,
}

impl SourceKind {
    /// Parses a stored source kind.
    pub(in crate::cognition) fn parse(value: &str) -> Option<Self> {
        match value {
            "conversation" => Some(Self::Conversation),
            "task_report" => Some(Self::TaskReport),
            "explicit_record" => Some(Self::ExplicitRecord),
            _ => None,
        }
    }
}

/// Who wrote an entry's text; window summaries are model interpretations.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(in crate::cognition) enum Authority {
    ModelInterpretation,
}

/// The provenance of an entry's sources.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(in crate::cognition) enum SourceClass {
    User,
    Assistant,
    TaskReport,
    Explicit,
    Mixed,
    Unknown,
}

impl SourceClass {
    pub(in crate::cognition) fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::TaskReport => "task_report",
            Self::Explicit => "explicit",
            Self::Mixed => "mixed",
            Self::Unknown => "unknown",
        }
    }
}

fn invalid(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
