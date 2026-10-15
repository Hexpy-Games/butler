//! Search-log slot summaries. Only partial boundary slots reread their byte ranges.
use super::{
    super::stream::number,
    log::{SLOT_MS, slot_start},
};
use crate::operations::log_tail::LogTail;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs::File,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    ops::Range,
    path::Path,
};
#[derive(Default)]
pub(super) struct SearchIndex {
    tail: LogTail,
    offset: u64,
    boundaries: BTreeMap<i64, Vec<Search>>,
    slots: BTreeMap<i64, SearchSlot>,
}
#[derive(Default)]
struct SearchSlot {
    count: u64,
    // One summary per slot; raw search payloads remain on disk.
    summary: Option<Search>,
    spans: Vec<Range<u64>>,
}
#[derive(Clone)]
struct Search {
    ts: f64,
    provider: String,
    error: Option<String>,
}
impl SearchIndex {
    pub(super) fn read(&mut self, root: &Path, since: f64, until: f64) -> Value {
        let path = root.join("metrics/web-search-usage.jsonl");
        let first = slot_start(since);
        let last = slot_start(until);
        self.boundaries
            .retain(|start, _| *start == first || *start == last);
        for key in [first, last] {
            if !self.slots.contains_key(&key) {
                self.boundaries.entry(key).or_default();
            }
        }
        let mut tail = std::mem::take(&mut self.tail);
        tail.advance(
            &path,
            self,
            |index| {
                index.slots.clear();
                index.offset = 0;
                for rows in index.boundaries.values_mut() {
                    rows.clear();
                }
            },
            Self::push,
        );
        self.tail = tail;
        let mut count = 0;
        let mut latest = None;
        let mut file = None;
        for (&start, slot) in self.slots.range(slot_start(since)..=slot_start(until)) {
            if start as f64 >= since && start.saturating_add(SLOT_MS) as f64 <= until {
                count += slot.count;
                if let Some(search) = &slot.summary {
                    update_latest(&mut latest, search.clone());
                }
            } else {
                let rows = self.boundaries.entry(start).or_insert_with(|| {
                    let file = file.get_or_insert_with(|| File::open(&path).ok());
                    file.as_mut()
                        .map_or_else(Vec::new, |file| read_boundary(file, slot))
                });
                for search in rows.iter().filter(|row| row.ts >= since && row.ts < until) {
                    count += 1;
                    update_latest(&mut latest, search.clone());
                }
            }
        }
        json!({"requestCount":count,"lastProvider":latest.as_ref().map(|row| &row.provider),
            "lastError":latest.as_ref().and_then(|row| row.error.as_ref())})
    }
    fn push(&mut self, line: &[u8]) {
        let start = self.offset;
        self.offset += line.len() as u64;
        let Some(search) = parse(line) else {
            return;
        };
        let key = slot_start(search.ts);
        if let Some(rows) = self.boundaries.get_mut(&key) {
            rows.push(search.clone());
        }
        let slot = self.slots.entry(key).or_default();
        slot.count += 1;
        update_latest(&mut slot.summary, search);
        if let Some(span) = slot.spans.last_mut().filter(|span| span.end == start) {
            span.end = self.offset;
        } else {
            slot.spans.push(start..self.offset);
        }
    }
}
fn parse(line: &[u8]) -> Option<Search> {
    let event: Value = serde_json::from_slice(line).ok()?;
    let ts = number(event.get("ts"))?;
    let provider = event.get("provider")?.as_str()?;
    if provider.trim().is_empty() {
        return None;
    }
    Some(Search {
        ts,
        provider: provider.into(),
        error: event
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}
fn read_boundary(file: &mut File, slot: &SearchSlot) -> Vec<Search> {
    let mut rows = Vec::new();
    for span in &slot.spans {
        if file.seek(SeekFrom::Start(span.start)).is_err() {
            continue;
        }
        let reader = BufReader::new(file.by_ref().take(span.end - span.start));
        rows.extend(
            reader
                .split(b'\n')
                .map_while(Result::ok)
                .filter_map(|line| parse(&line)),
        );
    }
    rows
}
fn update_latest(latest: &mut Option<Search>, row: Search) {
    if latest.as_ref().is_none_or(|current| current.ts <= row.ts) {
        *latest = Some(row);
    }
}
