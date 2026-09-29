use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

use super::{StatusTranscriptToolUsageBucket, TranscriptActivityCache};

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        Self(std::env::temp_dir().join(format!(
            "butler-transcript-activity-status-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        )))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

// test-category: pure-logic
#[test]
fn transcript_activity_is_scanned_per_file_and_resumes_where_it_grew() {
    let fixture = Fixture::new();
    let directory = fixture.0.join("transcripts");
    fs::create_dir_all(&directory).unwrap();
    let transcript = directory.join("fixture.jsonl");
    let contents = concat!(
        "{\"kind\":\"tool_call\",\"timestamp\":\"2026-09-22T12:00:00Z\",\"payload\":{\"name\":\"read_file\"}}\n",
        "{\"kind\":\"tool_result\",\"timestamp\":\"2026-09-22T12:00:01Z\",\"payload\":{\"name\":\"read_file\",\"ok\":false}}\n",
        "{\"kind\":\"tool_call\",\"timestamp\":\"2026-09-22T12:00:02Z\",\"payload\":{\"name\":\"write_file\"}}\n",
        "{\"kind\":\"tool_result\",\"timestamp\":\"2026-09-22T12:00:03Z\",\"payload\":{\"name\":\"write_file\",\"ok\":true}}\n",
        "{\"kind\":\"delivery\",\"timestamp\":\"2026-09-22T12:00:04Z\",\"payload\":{\"ok\":false,\"error\":\"fixture delivery failed\"}}\n",
        "{\"kind\":\"delivery\",\"timestamp\":\"2026-09-21T11:59:59Z\",\"payload\":{\"ok\":false,\"error\":\"expired failure\"}}\n",
        "{\"kind\":\"tool_call\",\"timestamp\":\"2026-09-22T12:00:05Z\",\"payload\":{\"name\":\"ignored_tail\"}}"
    );
    fs::write(&transcript, contents).unwrap();
    let now_ms = butler_core::js_date::parse_iso_millis("2026-09-22T12:00:05Z").unwrap();

    let activity = TranscriptActivityCache::default()
        .read(&fixture.0, now_ms)
        .unwrap();

    assert_eq!(
        activity.tools,
        StatusTranscriptToolUsageBucket {
            calls: 2,
            results: 2,
            successes: 1,
            failures: 1,
        }
    );
    assert_eq!(activity.by_tool["read_file"].failures, 1);
    assert_eq!(activity.by_tool["write_file"].successes, 1);
    assert_eq!(activity.delivery_failed, 1);
    assert_eq!(
        activity.last_delivery_error.as_deref(),
        Some("fixture delivery failed")
    );
    assert!(!fixture.0.join("metrics/transcript-activity").exists());

    // The cache scans only what grew: the unfinished last line is read once
    // it is finished, an oversize line is skipped whole, and a replaced (shorter)
    // file is scanned again from the start.
    let mut cache = TranscriptActivityCache::default();
    assert_eq!(cache.read(&fixture.0, now_ms).unwrap().tools.calls, 2);
    let mut grown = contents.to_owned();
    grown.push('\n');
    grown.push_str(&format!(
        "{{\"kind\":\"tool_call\",\"payload\":{{\"name\":\"oversize\"}},\"x\":\"{}\"}}\n",
        "x".repeat(5 * 1024 * 1024)
    ));
    grown.push_str("{\"kind\":\"tool_call\",\"payload\":{\"name\":\"after_oversize\"}}\n");
    fs::write(&transcript, &grown).unwrap();
    let activity = cache.read(&fixture.0, now_ms).unwrap();
    assert_eq!(
        activity.tools.calls, 4,
        "ignored_tail and after_oversize join"
    );
    assert!(activity.by_tool.contains_key("ignored_tail"));
    assert!(!activity.by_tool.contains_key("oversize"));
    fs::write(&transcript, &contents[..contents.find('\n').unwrap() + 1]).unwrap();
    assert_eq!(cache.read(&fixture.0, now_ms).unwrap().tools.calls, 1);
}
