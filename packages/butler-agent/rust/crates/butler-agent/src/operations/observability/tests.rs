use std::{fs, fs::OpenOptions, io::Write, path::PathBuf, sync::Arc};

use serde_json::json;

use super::{LogFile, LogFollower, tail_log_entries};

fn fixture(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("butler-{name}-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&path).unwrap();
    path
}

#[test]
fn log_tail_is_bounded_and_redacts_source_credentials() {
    let root = fixture("log-tail-test");
    let path = root.join("service.log");
    fs::write(
        &path,
        "old\nBearer token_value OPENAI_API_KEY=sk-fake bot123:fake\nlast\n",
    )
    .unwrap();
    let entries = tail_log_entries(
        &[LogFile {
            path: path.clone(),
            name: "service.log".into(),
        }],
        2,
    )
    .unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(
        entries[0].text,
        "Bearer [redacted] OPENAI_API_KEY=[redacted] bot[redacted]"
    );
    assert_eq!(entries[1].text, "last");
    assert!(!format!("{entries:?}").contains("token_value"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn log_follow_observes_append_truncation_and_rotation() {
    let root = fixture("log-follow-test");
    let path = root.join("service.log");
    fs::write(&path, "before\n").unwrap();
    let source = LogFile {
        path: path.clone(),
        name: "service.log".into(),
    };
    let mut follower = LogFollower::from_end(std::slice::from_ref(&source)).unwrap();
    OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(b"Bearer appended_token\n")
        .unwrap();
    assert_eq!(follower.poll().unwrap()[0].text, "Bearer [redacted]");

    fs::write(&path, "truncated\n").unwrap();
    assert_eq!(follower.poll().unwrap()[0].text, "truncated");

    fs::rename(&path, root.join("service.log.1")).unwrap();
    fs::write(&path, "rotated\n").unwrap();
    assert_eq!(follower.poll().unwrap()[0].text, "rotated");
    drop(follower);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn metric_tail_filters_and_projects_events_and_recorder_uses_shared_gate() {
    let root = fixture("metric-tail-test");
    let metrics = root.join("metrics");
    fs::create_dir_all(&metrics).unwrap();
    fs::write(
        root.join("butler.config.json"),
        r#"{"retained":{"value":7},"metrics":{"enabled":false}}"#,
    )
    .unwrap();
    let events = [
        json!({"schema":"butler.operational-metric.v1","ts":100,"category":"runtime","name":"old","status":"ok"}),
        json!({"schema":"butler.operational-metric.v1","ts":200,"category":"runtime","name":"middle","status":"ok","dimensions":{"api_key":"fake","count":2},"private":"never-copy"}),
        json!({"schema":"butler.operational-metric.v1","ts":300,"category":"runtime","name":"latest","status":"error"}),
    ];
    let mut content = events
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    content.push('\n');
    fs::write(metrics.join("operational-events.jsonl"), content).unwrap();
    let filtered = crate::operations::tail_operational_metric_events(&root, Some(200.0), 2);
    assert_eq!(filtered.len(), 2);
    assert_eq!(filtered[0]["name"], "middle");
    assert_eq!(filtered[1]["name"], "latest");
    assert!(!filtered[0].to_string().contains("never-copy"));
    assert!(filtered[0].pointer("/dimensions/api_key").is_none());
    assert_eq!(filtered[0]["dimensions"]["count"], 2);
    let tail = crate::operations::tail_operational_metric_events(&root, Some(200.0), 1);
    assert_eq!(tail.len(), 1);
    assert_eq!(tail[0]["name"], "latest");
    let recorder = crate::operations::ConversationMetrics::new(Arc::new(
        crate::operations::MetricFiles::new(root.clone()),
    ));
    let enabled = recorder.enabled();
    assert_eq!(crate::operations::metrics_enabled(&root), enabled);
    recorder.admission(crate::operations::AdmissionMeasure {
        session_id: "session-test",
        session_role: "test",
        source: "test",
        event_kind: "test",
        admitted: true,
        class_name: "test",
        reason: "test",
    });
    let content = fs::read_to_string(metrics.join("operational-events.jsonl")).unwrap();
    assert_eq!(content.contains("conversation_admission"), enabled);
    fs::remove_dir_all(root).unwrap();
}
