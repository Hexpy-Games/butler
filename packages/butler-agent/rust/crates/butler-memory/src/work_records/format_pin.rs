//! Byte-level format pin of the Work Dashboard and task CLI summaries.
//!
//! The golden in `fixtures/format/dashboard.json` was generated from the
//! pre-typing `serde_json::Value` projection over every planned-task case of
//! `source-bun.json`, direct tasks and delivery notifications. Run with
//! `BUTLER_BLESS_FORMAT=1` to regenerate it only when a format change is
//! intended.

use std::path::Path;

use serde_json::{Value, json};

use super::{DashboardDetail, WorkRecordReader};

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

/// Every planned-task case as its own task, plus direct tasks and
/// notifications covering each status and malformed file.
fn populate(root: &Path) -> Vec<String> {
    let fixture: Value = serde_json::from_str(include_str!("source-bun.json")).unwrap();
    let mut ids = Vec::new();
    for (index, case) in fixture["cases"].as_array().unwrap().iter().enumerate() {
        let id = format!("planned-{index:02}");
        for (relative, value) in case["files"].as_object().unwrap() {
            write(
                &root.join("tasks").join(&id).join(relative),
                value.as_str().unwrap(),
            );
        }
        ids.push(id);
    }
    let direct = [
        ("direct-running", "RUNNING", "", "", ""),
        (
            "direct-recoverable",
            "RECOVERABLE",
            "fix the parser",
            "",
            "",
        ),
        (
            "direct-done",
            "DONE",
            "implement the cache",
            "done",
            "run_shell (bun test)\nrun_shell result: exit=0",
        ),
        ("direct-done-empty", "REVIEWED", "research the api", "", ""),
        ("direct-failed", "FAILED", "", "blocked: auth", ""),
        ("direct-killed", "KILLED", "write docs", "", ""),
        ("direct-odd", "WEIRD", "", "", ""),
    ];
    for (id, status, request, result, log) in direct {
        let directory = root.join("tasks").join(id);
        write(&directory.join("status"), status);
        if !request.is_empty() {
            write(&directory.join("request.md"), request);
        }
        if !result.is_empty() {
            write(&directory.join("result.md"), result);
        }
        if !log.is_empty() {
            write(&directory.join("log.txt"), log);
        }
        ids.push(id.to_owned());
    }
    write(
        &root.join("tasks/direct-done/origin.json"),
        r#"{"version":1,"origin_session_id":"s","task_summary":"Cache   work\nsummary","transcript_ref":{"path":"t"}}"#,
    );
    write(
        &root.join("tasks/direct-done/worker_activity_events.jsonl"),
        "{\"semantic_phase\":\"executing\",\"completion_contract\":{\"has_commit_evidence\":true},\"evidence_refs\":[1,\"r\"]}\nnot json\n",
    );
    let notifications = root.join("runtime/task-notifications");
    for (name, body) in [
        (
            "a.json",
            r#"{"notificationId":"n1","status":"pending","taskId":"direct-done","createdAt":"2026-01-02"}"#,
        ),
        (
            "b.json",
            r#"{"notificationId":"n2","status":"failed","taskId":"direct-failed","originSummary":"Failed work","createdAt":"2026-01-01"}"#,
        ),
        ("c.json", r#"{"notificationId":"n3","status":"delivered"}"#),
        ("d.json", "[1,2]"),
        ("e.json", "not json"),
        ("f.txt", r#"{"notificationId":"ignored"}"#),
    ] {
        write(&notifications.join(name), body);
    }
    ids
}

#[test]
fn dashboard_and_cli_summaries_keep_their_bytes() {
    let root = std::env::temp_dir().join(format!("butler-dashboard-pin-{}", uuid::Uuid::new_v4()));
    let ids = populate(&root);
    let reader = WorkRecordReader::new(&root);
    let collation = butler_core::locale::LocaleCollation::new("en-US").unwrap();
    let mut summaries = serde_json::Map::new();
    for id in &ids {
        summaries.insert(
            id.clone(),
            reader.cli_task_summary(id).unwrap().unwrap_or(Value::Null),
        );
    }
    let pinned = json!({
        "dashboard": reader.dashboard(DashboardDetail::Public, None, &collation).unwrap(),
        "debug_dashboard": reader.dashboard(DashboardDetail::Debug, Some(3.0), &collation).unwrap(),
        "cli": reader.cli_task_summaries(None, &collation).unwrap(),
        "cli_failed": reader.cli_task_summaries(Some("failed"), &collation).unwrap(),
        "by_id": summaries,
    });
    let _ = std::fs::remove_dir_all(&root);
    let text = butler_core::json::pretty(&pinned);
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src/work_records/fixtures/format/dashboard.json");
    if std::env::var_os("BUTLER_BLESS_FORMAT").is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &text).unwrap();
        return;
    }
    let expected = std::fs::read_to_string(&path).unwrap();
    assert_eq!(text, expected, "dashboard format changed");
}
