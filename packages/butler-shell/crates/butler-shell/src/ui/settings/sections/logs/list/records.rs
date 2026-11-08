//! The list's rows (`logRecords.ts` `logListReducer`).
use std::collections::{BTreeSet, HashSet};

use super::api::{LogPage, LogRecord, Range};
use super::format::record_key;

/// `LOG_ROW_LIMIT`: rows the list keeps while live records arrive; older ones stay reachable
/// through More.
const ROW_LIMIT: usize = 500;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Status {
    Loading,
    Ready,
    Failed,
}

pub(super) struct RecordList {
    pub(super) status: Status,
    pub(super) rows: Vec<LogRecord>,
    /// The next page's window, or none when everything older is shown.
    pub(super) next: Option<Range>,
    since: Option<String>,
    /// Live records that arrived before the first page.
    early: Vec<LogRecord>,
    /// `useSeenCategories`: every category the list has shown this visit.
    pub(super) seen: BTreeSet<String>,
}

/// `newer` before `current`, each record once.
fn newest_first(newer: &[LogRecord], current: &[LogRecord]) -> Vec<LogRecord> {
    let mut seen = HashSet::new();
    newer
        .iter()
        .chain(current)
        .filter(|row| seen.insert(record_key(row)))
        .cloned()
        .collect()
}

fn next_window(page: &LogPage, range: &Range) -> Option<Range> {
    if page.exhausted {
        return None;
    }
    page.cursor.as_ref().map(|cursor| Range {
        since: range.since.clone(),
        until: range.until.clone(),
        cursor: Some(cursor.clone()),
    })
}

impl RecordList {
    pub(super) fn new() -> Self {
        Self {
            status: Status::Loading,
            rows: Vec::new(),
            next: None,
            since: None,
            early: Vec::new(),
            seen: BTreeSet::new(),
        }
    }

    pub(super) fn reset(&mut self, since: Option<String>) {
        self.status = Status::Loading;
        self.rows.clear();
        self.next = None;
        self.since = since;
        self.early.clear();
    }

    pub(super) fn failed(&mut self) {
        self.status = Status::Failed;
    }

    /// Past the limit, the oldest rows leave; More resumes at the oldest kept row.
    fn capped(&mut self, rows: Vec<LogRecord>) {
        self.rows = rows;
        if self.rows.len() > ROW_LIMIT {
            self.rows.truncate(ROW_LIMIT);
            let until = self.rows.last().map(|row| row.ts.clone());
            self.next = Some(Range {
                since: self.since.clone(),
                until,
                cursor: None,
            });
        }
        self.note_categories();
    }

    fn note_categories(&mut self) {
        for row in &self.rows {
            if !self.seen.contains(&row.category) {
                self.seen.insert(row.category.clone());
            }
        }
    }

    pub(super) fn first_page(&mut self, page: &LogPage, range: &Range) {
        self.next = next_window(page, range);
        self.status = Status::Ready;
        let early = std::mem::take(&mut self.early);
        self.capped(newest_first(&early, &page.rows));
    }

    /// More is asked for, so it grows the list; only live growth is capped. A page for a list
    /// that has since reset or moved on is dropped.
    pub(super) fn more_page(&mut self, page: &LogPage, range: &Range) {
        if self.next.as_ref() != Some(range) {
            return;
        }
        self.next = next_window(page, range);
        self.rows = newest_first(&self.rows, &page.rows);
        self.note_categories();
    }

    pub(super) fn live(&mut self, record: LogRecord) {
        if self.status != Status::Ready {
            let mut early = newest_first(&[record], &self.early);
            early.truncate(ROW_LIMIT);
            self.early = early;
            return;
        }
        let key = record_key(&record);
        if self.rows.iter().any(|row| record_key(row) == key) {
            return;
        }
        let rows = std::iter::once(record).chain(self.rows.drain(..)).collect();
        self.capped(rows);
    }
}
