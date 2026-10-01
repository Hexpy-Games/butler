//! Source receipt semantics paired with retained physical cache evidence.
//!
//! A complete cache job is statically valid when its receipt names this
//! generation and the job's revision, and actually valid when every entry it
//! admitted is still retained with current evidence (or was later excluded).

use std::collections::{HashMap, HashSet};

use crate::cognition::generation::cache::receipt::{JobReceiptView, WriteReceiptView};
use crate::cognition::graph::CacheReadinessRow;

pub(in crate::cognition::generation) struct CacheEvidence {
    pub static_invalid: usize,
    pub actual_invalid: usize,
    pub actual_invalid_jobs: Vec<String>,
}

/// Receipt, outcome, and retained-entry facts a job is judged against.
struct Judge<'a> {
    generation: &'a str,
    outcomes: &'a HashMap<String, bool>,
    valid_entries: &'a HashSet<String>,
    evicted: HashSet<String>,
}

pub(in crate::cognition::generation) fn evaluate(
    rows: &[CacheReadinessRow],
    outcomes: &HashMap<String, bool>,
    valid_entries: &HashSet<String>,
    generation: &str,
) -> CacheEvidence {
    let receipts = rows
        .iter()
        .map(|row| row.receipt_json.as_deref().and_then(JobReceiptView::parse))
        .collect::<Vec<_>>();
    let judge = Judge {
        generation,
        outcomes,
        valid_entries,
        evicted: evicted_entries(receipts.iter().flatten()),
    };
    let mut evidence = CacheEvidence {
        static_invalid: 0,
        actual_invalid: 0,
        actual_invalid_jobs: Vec::new(),
    };
    for (row, receipt) in rows.iter().zip(&receipts) {
        let (static_ok, actual_ok) = match receipt {
            Some(receipt) => (
                judge.statically_valid(row, receipt),
                judge.actually_valid(row, receipt),
            ),
            None => (false, false),
        };
        if !static_ok {
            evidence.static_invalid += 1;
        }
        if !actual_ok {
            evidence.actual_invalid += 1;
            evidence.actual_invalid_jobs.push(row.job_id.clone());
        }
    }
    evidence
}

/// Entries any receipt reports as excluded for a retention reason.
fn evicted_entries<'a>(receipts: impl Iterator<Item = &'a JobReceiptView>) -> HashSet<String> {
    receipts
        .flat_map(|receipt| receipt.entries.iter().flatten().flatten())
        .flat_map(|entry| entry.excluded_entries.iter().flatten().flatten())
        .filter(|entry| {
            matches!(
                entry.reason.as_deref(),
                Some("budget" | "oversized" | "expired" | "invalidated")
            )
        })
        .filter_map(|entry| entry.entry_id.clone())
        .collect()
}

impl Judge<'_> {
    fn names_job(&self, row: &CacheReadinessRow, entry: &WriteReceiptView) -> bool {
        entry.generation_id.as_deref() == Some(self.generation)
            && entry.source_revision.as_deref() == Some(row.revision.as_str())
    }

    fn statically_valid(&self, row: &CacheReadinessRow, receipt: &JobReceiptView) -> bool {
        match &receipt.entries {
            Some(entries) if !entries.is_empty() => entries.iter().all(|entry| {
                entry
                    .as_ref()
                    .is_some_and(|entry| self.names_job(row, entry))
            }),
            None => {
                receipt.outcome.as_deref() == Some("excluded")
                    && receipt.reason.as_deref() == Some("no_summary")
                    && receipt.generation.as_deref() == Some(self.generation)
                    && receipt.source_revision.as_deref() == Some(row.revision.as_str())
            }
            Some(_) => false,
        }
    }

    fn actually_valid(&self, row: &CacheReadinessRow, receipt: &JobReceiptView) -> bool {
        match &receipt.entries {
            Some(entries) if !entries.is_empty() => entries.iter().all(|entry| {
                entry
                    .as_ref()
                    .is_some_and(|entry| self.entry_accounted(row, entry))
            }),
            _ => {
                receipt.outcome.as_deref() == Some("excluded")
                    && matches!(
                        receipt.reason.as_deref(),
                        Some("no_summary" | "no_window_summary")
                    )
            }
        }
    }

    /// An admitted entry must still be retained; an excluded or evicted one
    /// needs nothing.
    fn entry_accounted(&self, row: &CacheReadinessRow, entry: &WriteReceiptView) -> bool {
        let Some(id) = entry.source_id.as_deref() else {
            return false;
        };
        if !self.names_job(row, entry) {
            return false;
        }
        let outcome = self.outcomes.get(id);
        if outcome == Some(&false)
            || (outcome.is_none() && (entry.admitted == Some(false) || self.evicted.contains(id)))
        {
            return true;
        }
        self.valid_entries.contains(id)
    }
}
