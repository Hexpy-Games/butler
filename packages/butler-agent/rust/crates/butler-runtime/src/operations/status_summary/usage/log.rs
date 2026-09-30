//! The prompt-usage log kept in memory: each read parses only the rows
//! appended since the previous one, and the all-time totals are folded once.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use serde_json::Value;

use super::buckets::{Buckets, PriceLookup};
use super::row::{Names, UsageRow};
use crate::operations::log_tail::LogTail;

const USAGE_FILE: &str = "metrics/prompt-cache-usage.jsonl";

/// Which rows a read covers.
#[derive(Clone, Copy, Default)]
pub(super) struct Window<'a> {
    /// Only this usage scope (`btcc-guided:<runtime session id>`).
    pub(super) scope: Option<&'a str>,
    /// Only requests at or after this epoch-millisecond time.
    pub(super) since_ts: Option<f64>,
}

/// The parsed log plus the all-time aggregate folded so far.
#[derive(Default)]
pub(crate) struct UsageLogIndex {
    tail: LogTail,
    names: Names,
    rows: Vec<UsageRow>,
    by_scope: HashMap<Arc<str>, Vec<u32>>,
    /// The all-time buckets, over `rows[..folded]`.
    all: Option<Buckets>,
    folded: usize,
}

impl UsageLogIndex {
    /// Parses the rows appended to the log since the last call.
    pub(super) fn refresh(&mut self, data_root: &Path) {
        let mut tail = std::mem::take(&mut self.tail);
        tail.advance(
            &data_root.join(USAGE_FILE),
            self,
            |index| {
                index.rows.clear();
                index.by_scope.clear();
                index.all = None;
                index.folded = 0;
            },
            UsageLogIndex::push_line,
        );
        self.tail = tail;
    }

    fn push_line(&mut self, line: &[u8]) {
        let Ok(event) = serde_json::from_slice::<Value>(line) else {
            return;
        };
        let Some(row) = UsageRow::parse(&event, &mut self.names) else {
            return;
        };
        let Ok(index) = u32::try_from(self.rows.len()) else {
            return;
        };
        self.by_scope
            .entry(row.scope.clone())
            .or_default()
            .push(index);
        self.rows.push(row);
    }

    /// The buckets over `window`; the unfiltered window is answered from the
    /// running all-time aggregate.
    pub(super) fn buckets(
        &mut self,
        window: Window<'_>,
        pricing: Option<PriceLookup<'_>>,
    ) -> Buckets {
        if window.scope.is_none() && window.since_ts.is_none() {
            return self.all_time(pricing);
        }
        let mut buckets = Buckets::new(pricing.is_some());
        let matches = |row: &UsageRow| window.since_ts.is_none_or(|since| row.ts >= since);
        match window.scope {
            Some(scope) => {
                let indices = self.by_scope.get(scope).map_or(&[][..], Vec::as_slice);
                for row in indices
                    .iter()
                    .filter_map(|index| self.rows.get(*index as usize))
                {
                    if matches(row) {
                        buckets.add(row, pricing);
                    }
                }
            }
            None => {
                for row in self.rows.iter().filter(|row| matches(row)) {
                    buckets.add(row, pricing);
                }
            }
        }
        buckets
    }

    fn all_time(&mut self, pricing: Option<PriceLookup<'_>>) -> Buckets {
        let all = self
            .all
            .get_or_insert_with(|| Buckets::new(pricing.is_some()));
        for row in self.rows.iter().skip(self.folded) {
            all.add(row, pricing);
        }
        self.folded = self.rows.len();
        all.clone()
    }
}
