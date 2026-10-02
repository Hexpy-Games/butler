use std::{fs, fs::OpenOptions, io::Write, path::PathBuf, sync::Arc};

use serde_json::json;

use super::{LogFile, LogFollower, tail_log_entries};

fn fixture(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("butler-{name}-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&path).unwrap();
    path
}

// test-category: pure-logic
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
    assert_eq!(
        super::export_line("[native-model] prompt=private conversation"),
        None
    );
    assert_eq!(super::export_line("private conversation text"), None);
    let safe =
        super::export_line("[native-app] unavailable token=private refresh_token=private sk-fake")
            .unwrap();
    assert!(!safe.contains("private"), "{safe}");
    assert!(!safe.contains("sk-fake"), "{safe}");
    for sensitive in [
        "Bearer fixture+suffix/remaining=",
        "Cookie: butler_session_123=v2.fixture.fixture-cookie; other=fixture-other",
        "Set-Cookie: butler_session_123=v2.fixture.fixture-cookie; Path=/; HttpOnly",
        r#"Cookie: quoted="fixture-cookie"; other=fixture-other"#,
        r#"Set-Cookie: quoted="fixture-cookie"; Path=/"#,
        r#"{"cookie":"quoted=\"fixture-cookie\"; other=fixture-other","count":42}"#,
        r#"{'cookie':"quoted=\"fixture-cookie\"; other=fixture-other","count":42}"#,
        r#"{"cookie":"v2.fixture.fixture-cookie","pairing_code":"12349876"}"#,
        "pairing code: 12349876",
        "pairing code: 1234 9876",
        "code=1234 9876",
        "connection code: ABCD EFGH JKLM NPQR",
        "url=http://localhost/connect?code=ABCD-EFGH-JKLM-NPQR",
        "path=/home/fixture-owner/data",
        "path=/Users/fixture-owner/data",
        r"path=C:\Users\fixture-owner\data",
        r#"{"path":"C:\\Users\\fixture-owner\\data"}"#,
        r#"path="C:\Users\fixture owner\data""#,
        "path=/Users/fixture owner/data",
        r#"path="/Users/fixture owner""#,
        r#"path="C:\Users\fixture owner""#,
        r"path=\\wsl.localhost\Ubuntu\home\fixture-owner\data",
    ] {
        let input = format!("[native-app] unavailable {sensitive}");
        let safe = super::export_line(&input).unwrap();
        for secret in [
            "fixture+suffix",
            "remaining",
            "fixture-cookie",
            "fixture-other",
            "12349876",
            "1234 9876",
            "9876",
            "ABCD EFGH JKLM NPQR",
            "EFGH",
            "JKLM",
            "NPQR",
            "ABCD-EFGH-JKLM-NPQR",
            "fixture-owner",
            "fixture owner",
        ] {
            assert!(
                !safe.contains(secret),
                "export leaked a fixture credential or username"
            );
        }
        assert!(safe.contains("[native-app] unavailable"));
        if sensitive.contains(r#""count""#) {
            assert!(safe.contains(r#""count":42"#), "JSON fields were lost");
        }
    }
    let safe = super::export_line(
        "[service-lifecycle] event=exit pid=12349876 code=SIGKILL count=12349876",
    )
    .unwrap();
    assert!(safe.contains("pid=12349876 code=SIGKILL count=12349876"));
    let exits = (1..=7).map(|i| super::LogEntry { file: String::new(),
        text: format!("2026-10-02T00:00:0{i}Z [service-lifecycle] event=exit version=0.1.0-preview.5+abc pid={i} code=crash Service exited unexpectedly.") }).collect::<Vec<_>>();
    let summary = super::log_summary(
        "Version: preview\nOS: Linux\nInstall kind: standalone\nService manager present: false",
        &exits,
    );
    assert_eq!(
        summary
            .lines()
            .filter(|line| line.starts_with("2026-"))
            .count(),
        5
    );
    assert!(!summary.contains("pid=1 "));
    assert!(summary.contains("Last error: 2026-10-02T00:00:07Z"));
    assert!(super::log_summary("Version: preview", &[]).contains("none recorded"));
    assert!(super::log_is_error(
        "[service-lifecycle] event=exit code=SIGKILL Service was terminated by a signal."
    ));
    assert!(!super::log_is_error(
        "[service-lifecycle] event=exit code=requested_stop Service stopped on request."
    ));
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
