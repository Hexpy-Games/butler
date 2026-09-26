use super::*;
use serde_json::Value;
use std::{ffi::OsString, path::PathBuf};

struct Fixture {
    root: PathBuf,
    data: PathBuf,
    installation: ResolvedInstallation,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("butler-work-cli-{}", uuid::Uuid::new_v4()));
        let app = root.join("app");
        let resources = app.join("resources");
        std::fs::create_dir_all(&resources).unwrap();
        let executable = app.join("butler-agent");
        std::fs::write(&executable, "fixture").unwrap();
        let installation = ResolvedInstallation::desktop(executable, app, resources).unwrap();
        Self {
            data: root.join("data"),
            root,
            installation,
        }
    }

    fn task(&self, id: &str, status: &str, request: &str) -> PathBuf {
        let directory = self.data.join("tasks").join(id);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("status"), status).unwrap();
        std::fs::write(directory.join("request.md"), request).unwrap();
        std::fs::write(directory.join("log.txt"), "private worker log").unwrap();
        directory
    }

    async fn run(&self, args: &[&str]) -> NativeWorkCliResult {
        let mut raw = vec![OsString::from("work")];
        raw.extend(args.iter().map(OsString::from));
        super::run(self.installation.clone(), raw).await
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn json_output(result: &NativeWorkCliResult) -> Value {
    serde_json::from_str(&result.stdout).unwrap()
}

#[tokio::test]
async fn list_show_and_resume_use_safe_summaries_and_resume_is_validation_only() {
    let fixture = Fixture::new();
    let task = fixture.task("recoverable", "RECOVERABLE", "secret customer request");
    for index in 0..26 {
        fixture.task(&format!("old-{index:02}"), "FAILED", "older request");
    }
    let status_before = std::fs::read(task.join("status")).unwrap();
    let list = fixture
        .run(&["list", "--data", fixture.data.to_str().unwrap(), "--json"])
        .await;
    assert_eq!(list.exit_code, 0);
    let list = json_output(&list);
    assert_eq!(list["data"]["items"].as_array().unwrap().len(), 25);
    let item = &list["data"]["items"][0];
    assert_eq!(
        item["user_summary"],
        "direct work is recoverable (RECOVERABLE)."
    );
    assert_eq!(item["has_log"], true);
    assert!(!item.to_string().contains("secret customer request"));
    assert!(!item.to_string().contains("private worker log"));

    let filtered = fixture
        .run(&[
            "list",
            "--status",
            "recoverable",
            "--data",
            fixture.data.to_str().unwrap(),
            "--json",
        ])
        .await;
    let filtered = json_output(&filtered);
    assert_eq!(filtered["data"]["items"].as_array().unwrap().len(), 1);
    assert_eq!(filtered["data"]["items"][0]["task_id"], "recoverable");

    let shown = fixture
        .run(&[
            "show",
            "recoverable",
            "--data",
            fixture.data.to_str().unwrap(),
            "--json",
        ])
        .await;
    assert_eq!(shown.exit_code, 0);
    assert_eq!(json_output(&shown)["data"]["task_id"], "recoverable");

    let resumed = fixture
        .run(&[
            "resume",
            "latest",
            "--data",
            fixture.data.to_str().unwrap(),
            "--json",
        ])
        .await;
    assert_eq!(resumed.exit_code, 0);
    let resumed = json_output(&resumed);
    assert_eq!(resumed["data"]["resumed"], false);
    assert_eq!(resumed["data"]["intent"]["task_id"], "recoverable");
    assert_eq!(std::fs::read(task.join("status")).unwrap(), status_before);
}

#[tokio::test]
async fn cancel_and_retry_are_explicitly_unsupported_without_mutating_legacy_state() {
    let fixture = Fixture::new();
    let task = fixture.task("running", "RUNNING", "request");
    let notification = fixture
        .data
        .join("runtime/task-notifications/notify-1.json");
    std::fs::create_dir_all(notification.parent().unwrap()).unwrap();
    std::fs::write(
        &notification,
        r#"{"notificationId":"notify-1","taskId":"running","status":"failed"}"#,
    )
    .unwrap();
    let status_before = std::fs::read(task.join("status")).unwrap();
    let notification_before = std::fs::read(&notification).unwrap();

    for args in [
        vec!["cancel", "running", "--yes"],
        vec!["retry", "notify-1"],
    ] {
        let mut full = args;
        full.extend(["--data", fixture.data.to_str().unwrap(), "--json"]);
        let result = fixture.run(&full).await;
        assert_ne!(result.exit_code, 0);
        let output = json_output(&result);
        assert_eq!(output["ok"], false);
        assert_eq!(output["error"]["code"], "unsupported_operation");
    }

    assert_eq!(std::fs::read(task.join("status")).unwrap(), status_before);
    assert_eq!(std::fs::read(notification).unwrap(), notification_before);
}

#[tokio::test]
async fn missing_data_remains_absent_and_legacy_dashboard_actions_are_disabled() {
    let fixture = Fixture::new();
    let no_data = fixture
        .run(&["list", "--data", fixture.data.to_str().unwrap(), "--json"])
        .await;
    assert_eq!(no_data.exit_code, 0);
    assert!(!fixture.data.exists());

    let recoverable = fixture.task("recoverable", "RECOVERABLE", "private task summary");
    std::fs::write(
        recoverable.join("plan.json"),
        r#"{"type":"planned","goal":"private plan goal"}"#,
    )
    .unwrap();
    let report = fixture.task("report", "PUBLIC_REPORT_READY", "private report task");
    std::fs::write(
        report.join("plan.json"),
        r#"{"type":"planned","goal":"private plan goal"}"#,
    )
    .unwrap();
    std::fs::write(report.join("public-report.md"), "private report body").unwrap();
    let _running = fixture.task("running", "RUNNING", "private running task");
    let repair = fixture.task("repair", "REVIEW_FAILED", "private repair task");
    std::fs::write(
        repair.join("plan.json"),
        r#"{"type":"planned","goal":"private plan goal"}"#,
    )
    .unwrap();
    let notification = fixture
        .data
        .join("runtime/task-notifications/notify-1.json");
    std::fs::create_dir_all(notification.parent().unwrap()).unwrap();
    std::fs::write(
        notification,
        r#"{"notificationId":"notify-1","taskId":"report","status":"failed"}"#,
    )
    .unwrap();

    let dashboard = fixture
        .run(&[
            "dashboard",
            "--data",
            fixture.data.to_str().unwrap(),
            "--json",
        ])
        .await;
    assert_eq!(dashboard.exit_code, 0);
    let dashboard = json_output(&dashboard)["data"].clone();
    for key in ["active", "recoverable", "failed", "reportReady"] {
        let item = &dashboard[key][0];
        assert!(!item["summary"].as_str().unwrap().contains("private"));
        for action in item["actions"].as_array().unwrap() {
            if matches!(action["action"].as_str(), Some("resume" | "cancel")) {
                assert_eq!(action["enabled"], false);
                assert!(action["reason"].as_str().unwrap().contains("owner"));
            }
        }
        if key == "active" {
            assert!(item["raw_id"].is_null());
        }
        let missing_owner = if key == "reportReady" {
            "no native delivery owner"
        } else {
            "no native execution owner"
        };
        assert!(
            item["next_step"]
                .as_str()
                .unwrap()
                .to_ascii_lowercase()
                .contains(missing_owner)
        );
    }
    let retry = &dashboard["delivery"][0]["actions"][0];
    assert_eq!(retry["enabled"], false);
    assert!(retry["reason"].as_str().unwrap().contains("owner"));
}
