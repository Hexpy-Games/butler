//! Private benchmark-only inclusive duration probes.
use parking_lot::Mutex;
use std::time::Instant;
static EVENTS: Mutex<Vec<(&'static str, f64)>> = Mutex::new(Vec::new());
pub struct Probe {
    label: &'static str,
    start: Instant,
}
impl Probe {
    pub fn new(label: &'static str) -> Self {
        Self {
            label,
            start: Instant::now(),
        }
    }
}
impl Drop for Probe {
    fn drop(&mut self) {
        EVENTS
            .lock()
            .push((self.label, self.start.elapsed().as_secs_f64() * 1000.0));
    }
}
static SQL: Mutex<Vec<(String, f64, i32, i32)>> = Mutex::new(Vec::new());
pub fn attach(db: &rusqlite::Connection) {
    use rusqlite::trace::{TraceEvent, TraceEventCodes};
    db.trace_v2(
        TraceEventCodes::SQLITE_TRACE_PROFILE,
        Some(|event| {
            if let TraceEvent::Profile(statement, duration) = event
                && !duration.is_zero()
            {
                SQL.lock().push((
                    statement.expanded_sql().unwrap_or_default(),
                    duration.as_secs_f64() * 1000.0,
                    statement.get_status(rusqlite::StatementStatus::FullscanStep),
                    statement.get_status(rusqlite::StatementStatus::VmStep),
                ));
            }
        }),
    );
}
pub fn take_sql() -> Vec<(String, f64, i32, i32)> {
    std::mem::take(&mut *SQL.lock())
}
pub fn take() -> Vec<(&'static str, f64, usize, f64)> {
    let events = std::mem::take(&mut *EVENTS.lock());
    let mut totals = std::collections::BTreeMap::<&'static str, (f64, usize, f64)>::new();
    for (label, ms) in events {
        let entry = totals.entry(label).or_insert((0.0, 0, ms));
        entry.0 += ms;
        entry.1 += 1;
    }
    totals
        .into_iter()
        .map(|(label, (ms, count, first))| (label, ms, count, first))
        .collect()
}

pub fn mark(label: &'static str) {
    EVENTS.lock().push((label, 0.0));
}
