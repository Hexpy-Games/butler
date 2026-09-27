use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

use super::read_transcript_activity;

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        Self(std::env::temp_dir().join(format!(
            "butler-status-activity-stale-index-{}-{}",
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
fn status_ignores_legacy_aggregate_and_deltas_without_modifying_them() {
    let fixture = Fixture::new();
    let aggregate_dir = fixture.0.join("metrics/transcript-activity");
    fs::create_dir_all(&aggregate_dir).unwrap();
    let aggregate_path = aggregate_dir.join("aggregate.json");
    let aggregate = br#"{"version":1,"deliveryFailed":0,"tools":{"calls":2,"results":0,"successes":0,"failures":0},"byTool":{"stale":{"calls":2,"results":0,"successes":0,"failures":0}}}"#;
    fs::write(&aggregate_path, aggregate).unwrap();
    let deltas_path = aggregate_dir.join("aggregate-deltas.jsonl");
    let deltas = b"{\"kind\":\"tool_call\",\"payload\":{\"name\":\"must_not_be_read\"}}\n";
    fs::write(&deltas_path, deltas).unwrap();

    let transcript_dir = fixture.0.join("transcripts");
    fs::create_dir_all(&transcript_dir).unwrap();
    let timestamp = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let event = serde_json::json!({
        "kind": "tool_call",
        "timestamp": timestamp,
        "payload": { "name": "after_index" }
    });
    fs::write(transcript_dir.join("fixture.jsonl"), format!("{event}\n")).unwrap();

    let projection = read_transcript_activity(&fixture.0);

    assert_eq!(
        projection.status["reason"].as_str(),
        Some("read_only_transcript_activity_fallback")
    );
    assert_eq!(projection.facts["tools"]["calls"].as_u64(), Some(1));
    assert_eq!(
        projection.facts["byTool"]["after_index"]["calls"].as_u64(),
        Some(1)
    );
    assert!(projection.facts["byTool"].get("stale").is_none());
    assert_eq!(fs::read(aggregate_path).unwrap(), aggregate.to_vec());
    assert_eq!(fs::read(deltas_path).unwrap(), deltas.to_vec());
}
