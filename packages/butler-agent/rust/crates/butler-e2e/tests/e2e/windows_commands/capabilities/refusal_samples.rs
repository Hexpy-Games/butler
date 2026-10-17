//! Correlate content-free storage timings with each provider-observed refusal.
use super::{Access, Duration, provider};
use std::collections::HashMap;

pub(super) struct Sample {
    marks: Vec<(&'static str, u128)>,
    total: u128,
}
impl Sample {
    pub(super) fn new(script: &provider::Script, elapsed: Duration) -> Self {
        Self {
            marks: script.marks.lock().map(|m| m.clone()).unwrap_or_default(),
            total: elapsed.as_micros(),
        }
    }
    fn mark(&self, name: &str) -> u128 {
        self.marks.iter().find(|m| m.0 == name).map_or(0, |m| m.1)
    }
    fn delta(&self, from: &str, to: &str) -> u128 {
        let (from, to) = (self.mark(from), self.mark(to));
        if from == 0 || to == 0 {
            0
        } else {
            to.saturating_sub(from)
        }
    }
}
fn number(fields: &HashMap<&str, &str>, key: &str) -> u128 {
    fields.get(key).and_then(|s| s.parse().ok()).unwrap_or(0)
}
#[derive(Default)]
struct Storage {
    passes: u128,
    busy: u128,
    inline: u128,
    commit_sum: u128,
    commit_max: u128,
    decision: u128,
    transcript: u128,
    private: u128,
    read_max: u128,
}
impl Storage {
    fn observe(&mut self, sample: &Sample, line: &str) {
        let fields: HashMap<_, _> = line
            .split_whitespace()
            .filter_map(|f| f.split_once('='))
            .collect();
        let end = number(&fields, "utc_us");
        let low = sample.mark("sent");
        let high = sample.mark("result_delivered");
        if low == 0 || high == 0 {
            return;
        }
        if line.starts_with("command_checkpoint_timing ") {
            let duration = number(&fields, "checkpoint_us");
            let start = fields
                .get("start_utc_us")
                .and_then(|s| s.parse().ok())
                .unwrap_or_else(|| end.saturating_sub(duration));
            if start >= high || end <= low {
                return;
            }
            let overlap = end.min(high).saturating_sub(start.max(low));
            if fields.get("mode") == Some(&"background") {
                self.passes += 1;
                self.busy += overlap;
            } else {
                self.inline += overlap;
            }
            return;
        }
        if end < low || end > high {
            return;
        }
        let elapsed = number(&fields, "elapsed_us");
        match (fields.get("phase").copied(), fields.get("event").copied()) {
            (Some("app_sqlite_commit"), Some("sqlite_done")) => {
                self.commit_sum += elapsed;
                self.commit_max = self.commit_max.max(elapsed);
            }
            (Some("approval_decision"), Some("returned")) => self.decision += elapsed,
            (Some("private_replace"), Some("returned")) => self.private += elapsed,
            (Some("app_sqlite_read"), Some("sql_done")) => {
                self.read_max = self.read_max.max(elapsed);
            }
            _ => {}
        }
    }
}
pub(super) fn print(access: Access, samples: &[Sample], logs: &str) {
    for (i, sample) in samples.iter().enumerate() {
        let mut storage = Storage::default();
        let mut written = HashMap::new();
        for line in logs.lines().filter(|l| l.starts_with("command_")) {
            storage.observe(sample, line);
            // Transcript sync time excludes serialization and file opening.
            let fields: HashMap<_, _> = line
                .split_whitespace()
                .filter_map(|f| f.split_once('='))
                .collect();
            let utc = number(&fields, "utc_us");
            if fields.get("phase") != Some(&"transcript_append") {
                continue;
            }
            if let Some(id) = fields.get("id") {
                match fields.get("event").copied() {
                    Some("written") => {
                        written.insert(*id, number(&fields, "elapsed_us"));
                    }
                    Some("synced")
                        if utc >= sample.mark("sent") && utc <= sample.mark("result_delivered") =>
                    {
                        storage.transcript += written.get(id).map_or(0, |start| {
                            number(&fields, "elapsed_us").saturating_sub(*start)
                        });
                    }
                    _ => {}
                }
            }
        }
        eprintln!(
            "REFUSAL-SAMPLE access={access:?} i={i} total_us={} card_us={} allow_us={} resume_us={} ckpt_passes={} ckpt_busy_us={} ckpt_inline_us={} app_commit_sum_us={} app_commit_max_us={} decision_us={} transcript_sync_us={} private_replace_us={} app_read_max_us={}",
            sample.total,
            sample.delta("sent", "approval_listed"),
            sample.delta("allow_submitted", "allow_returned"),
            sample.delta("allow_returned", "result_delivered"),
            storage.passes,
            storage.busy,
            storage.inline,
            storage.commit_sum,
            storage.commit_max,
            storage.decision,
            storage.transcript,
            storage.private,
            storage.read_max,
        );
    }
}
