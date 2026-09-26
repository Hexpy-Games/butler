use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

use super::{StatusTranscriptToolUsageBucket, read_status_transcript_activity_at};

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

#[test]
fn missing_index_falls_back_to_transcript_activity_without_writes() {
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
    let now_ms = crate::js_date::parse_iso_millis("2026-09-22T12:00:05Z").unwrap();

    let activity = read_status_transcript_activity_at(&fixture.0, now_ms).unwrap();

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
}

#[test]
fn latest_delivery_without_error_does_not_reuse_an_older_error() {
    let mut activity = super::ActivityAccumulator::default();
    activity.apply_event(&serde_json::json!({
        "kind": "delivery",
        "timestamp": "2026-09-22T12:00:03Z",
        "payload": { "ok": false, "error": "older error" }
    }));
    activity.apply_event(&serde_json::json!({
        "kind": "delivery",
        "timestamp": "2026-09-22T12:00:04Z",
        "payload": { "ok": false }
    }));

    activity.prune(crate::js_date::parse_iso_millis("2026-09-22T12:00:05Z").unwrap());

    assert_eq!(activity.summary.last_delivery_error, None);
}

#[test]
fn missing_transcripts_return_a_truthful_empty_fallback() {
    let fixture = Fixture::new();
    let now_ms = crate::js_date::parse_iso_millis("2026-09-22T12:00:05Z").unwrap();

    let activity = read_status_transcript_activity_at(&fixture.0, now_ms).unwrap();

    assert_eq!(activity.tools, StatusTranscriptToolUsageBucket::default());
    assert!(activity.by_tool.is_empty());
    assert_eq!(activity.delivery_failed, 0);
    assert_eq!(activity.last_delivery_error, None);
}
