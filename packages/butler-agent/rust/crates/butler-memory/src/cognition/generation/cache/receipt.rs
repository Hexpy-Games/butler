//! Receipts a cache job stores in `hot_cache_receipt_json` and per-entry
//! outcome rows, with the lenient views health reads them with.

use serde::{Deserialize, Serialize};

use crate::lenient;

/// Why a cache job or entry was excluded.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(in crate::cognition) enum ExclusionReason {
    /// The episode has no completed summary.
    NoSummary,
    /// No window of the episode produced a summary.
    NoWindowSummary,
    /// The entry's `valid_until` has passed.
    Expired,
    /// The entry lost its current graph evidence.
    Invalidated,
    /// The entry alone exceeds the cache budget.
    Oversized,
    /// The entry did not fit in the remaining budget.
    Budget,
}

impl ExclusionReason {
    pub(in crate::cognition) fn as_str(self) -> &'static str {
        match self {
            Self::NoSummary => "no_summary",
            Self::NoWindowSummary => "no_window_summary",
            Self::Expired => "expired",
            Self::Invalidated => "invalidated",
            Self::Oversized => "oversized",
            Self::Budget => "budget",
        }
    }
}

/// Whether a job's summary reached the cache.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(in crate::cognition) enum CacheOutcome {
    /// At least one entry was admitted.
    Applied,
    /// Nothing was admitted.
    Excluded,
}

/// An entry the write removed from the cache.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(in crate::cognition) struct ExcludedEntryReceipt {
    pub entry_id: String,
    pub reason: ExclusionReason,
}

/// Whether an entry belongs to one project or every session.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(in crate::cognition) enum ReceiptScope {
    Project,
    Global,
}

/// The receipt of writing one window entry to the cache file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(in crate::cognition) struct CacheWriteReceipt {
    pub schema_version: &'static str,
    pub source_id: String,
    pub scope: ReceiptScope,
    pub project_id: Option<String>,
    pub path: String,
    pub replayed: bool,
    pub compacted: bool,
    pub bytes: usize,
    pub generation_id: String,
    pub episode_id: String,
    pub source_revision: String,
    pub excluded_entries: Vec<ExcludedEntryReceipt>,
    pub admitted: bool,
}

/// The receipt a completed cache job stores. Fields absent from a shape are
/// omitted, so each shape keeps its historical key order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(in crate::cognition) struct CacheJobReceipt {
    #[serde(skip_serializing_if = "Option::is_none")]
    schema: Option<&'static str>,
    outcome: CacheOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<ExclusionReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    generation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    episode_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    entries: Option<Vec<CacheWriteReceipt>>,
}

impl CacheJobReceipt {
    /// The episode has no completed summary.
    pub(in crate::cognition) fn no_summary(
        generation: &str,
        episode_id: &str,
        source_revision: &str,
    ) -> Self {
        Self {
            schema: Some("butler.memory-hot-cache-receipt.v1"),
            outcome: CacheOutcome::Excluded,
            reason: Some(ExclusionReason::NoSummary),
            generation: Some(generation.to_owned()),
            episode_id: Some(episode_id.to_owned()),
            source_revision: Some(source_revision.to_owned()),
            entries: None,
        }
    }

    /// No window produced a summary.
    pub(in crate::cognition) fn no_window_summary() -> Self {
        Self {
            schema: None,
            outcome: CacheOutcome::Excluded,
            reason: Some(ExclusionReason::NoWindowSummary),
            generation: None,
            episode_id: None,
            source_revision: None,
            entries: Some(Vec::new()),
        }
    }

    /// The window entries were written; applied when any was admitted.
    pub(in crate::cognition) fn written(entries: Vec<CacheWriteReceipt>) -> Self {
        let applied = entries.iter().any(|entry| entry.admitted);
        Self {
            schema: None,
            outcome: if applied {
                CacheOutcome::Applied
            } else {
                CacheOutcome::Excluded
            },
            reason: None,
            generation: None,
            episode_id: None,
            source_revision: None,
            entries: Some(entries),
        }
    }
}

/// The outcome row stored for one entry id.
#[derive(Clone, Debug)]
pub(in crate::cognition) struct EntryOutcome {
    pub entry_id: String,
    pub admitted: bool,
    pub reason: Option<ExclusionReason>,
    /// The write receipt the outcome came from.
    pub receipt: CacheWriteReceipt,
}

/// Lenient view of a stored job receipt.
#[derive(Debug, Default, Deserialize)]
pub(in crate::cognition) struct JobReceiptView {
    /// `None` when not an array; `Some(None)` items are unreadable entries.
    #[serde(default, deserialize_with = "lenient::items")]
    pub entries: Option<Vec<Option<WriteReceiptView>>>,
    #[serde(default, deserialize_with = "lenient::items")]
    pub excluded_entries: Option<Vec<Option<ExcludedEntryView>>>,
}

impl JobReceiptView {
    /// Parses a stored receipt; `None` when it is not a JSON object.
    pub(in crate::cognition) fn parse(raw: &str) -> Option<Self> {
        lenient::object(raw)
    }
}

/// Lenient view of one stored write receipt.
#[derive(Debug, Default, Deserialize)]
pub(in crate::cognition) struct WriteReceiptView {
    #[serde(default, deserialize_with = "lenient::items")]
    pub excluded_entries: Option<Vec<Option<ExcludedEntryView>>>,
}

/// Lenient view of one excluded entry.
#[derive(Debug, Default, Deserialize)]
pub(in crate::cognition) struct ExcludedEntryView {
    #[serde(default, deserialize_with = "lenient::option")]
    pub reason: Option<String>,
}

impl ExcludedEntryView {
    /// Whether the entry was evicted for size or budget.
    pub(in crate::cognition) fn evicted_for_space(&self) -> bool {
        matches!(self.reason.as_deref(), Some("budget" | "oversized"))
    }
}
