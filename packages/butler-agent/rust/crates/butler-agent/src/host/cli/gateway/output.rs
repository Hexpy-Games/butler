use std::process::ExitCode;

use serde_json::{Value, json};

use super::arguments::Action;

pub(super) fn command_name(action: Action) -> &'static str {
    match action {
        Action::List => "butler gateway list",
        Action::Status => "butler gateway status app",
        Action::Inspect => "butler gateway inspect app",
        Action::Enable => "butler gateway enable app",
        Action::Disable => "butler gateway disable app",
        Action::Configure => "butler gateway configure app",
        Action::Test => "butler gateway test app",
        Action::Start => "butler gateway start app",
        Action::Stop => "butler gateway stop app",
        Action::Restart => "butler gateway restart app",
        Action::App => "butler gateway app",
        Action::Run => "butler gateway run app",
        Action::Logs => "butler gateway logs app",
    }
}

pub(super) fn render(action: Action, value: &Value) -> String {
    if matches!(action, Action::List) {
        let view = &value["gateways"][0];
        return format!(
            "app: {} enabled={} configured={}",
            view["status"].as_str().unwrap_or("offline"),
            view["enabled"].as_bool().unwrap_or(false),
            view["configured"].as_bool().unwrap_or(false),
        );
    }
    if matches!(action, Action::Enable | Action::Disable) {
        return format!(
            "app gateway {}.",
            if matches!(action, Action::Enable) {
                "enabled"
            } else {
                "disabled"
            }
        );
    }
    if matches!(action, Action::Configure) {
        return format!(
            "App gateway configured.\nurl: {}\ndb configured: {}",
            value["config"]["serverUrl"].as_str().unwrap_or("unknown"),
            value["config"]["dbConfigured"].as_bool().unwrap_or(false),
        );
    }
    if matches!(action, Action::Test) {
        return format!(
            "App gateway test: {}.",
            if value["ok"] == true {
                "passed"
            } else {
                "not running"
            }
        );
    }
    if matches!(action, Action::Start) {
        if value["reason"] == "disabled" {
            return "App gateway is disabled. Run `butler gateway enable app` first.".into();
        }
        return if value["alreadyRunning"] == true {
            "App gateway already running.".into()
        } else {
            format!(
                "App gateway started pid={}",
                value["pid"].as_u64().unwrap_or_default()
            )
        };
    }
    if matches!(action, Action::Stop) {
        return if value["alreadyStopped"] == true {
            "App gateway was not running.".into()
        } else {
            "App gateway stopped.".into()
        };
    }
    if matches!(action, Action::Restart) {
        return if value["reason"] == "disabled" {
            "App gateway is disabled. Run `butler gateway enable app` first.".into()
        } else {
            format!(
                "App gateway restarted pid={}",
                value["pid"].as_u64().unwrap_or_default()
            )
        };
    }
    if matches!(action, Action::Logs) {
        let Some(lines) = value["lines"].as_array() else {
            return "No app gateway log lines found.".into();
        };
        if lines.is_empty() {
            return "No app gateway log lines found.".into();
        }
        return lines
            .iter()
            .map(|line| {
                format!(
                    "[{}] {}",
                    line["file"].as_str().unwrap_or(""),
                    line["text"].as_str().unwrap_or("")
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
    }
    let mut lines = vec![
        format!(
            "{}: {}",
            value["id"].as_str().unwrap_or("app"),
            value["status"].as_str().unwrap_or("offline")
        ),
        format!("enabled: {}", value["enabled"].as_bool().unwrap_or(false)),
        format!(
            "configured: {}",
            value["configured"].as_bool().unwrap_or(false)
        ),
        format!(
            "url: {}",
            value["config"]["serverUrl"].as_str().unwrap_or("unknown")
        ),
        format!(
            "lifecycle: {}",
            value["lifecycle"].as_str().unwrap_or("process")
        ),
        format!("running: {}", value["running"].as_bool().unwrap_or(false)),
        format!(
            "restart required: {}",
            value["restartRequired"].as_bool().unwrap_or(false)
        ),
    ];
    if let Some(next) = value["nextActions"].as_array() {
        let next = next
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(" | ");
        if !next.is_empty() {
            lines.push(format!("next: {next}"));
        }
    }
    if matches!(action, Action::Inspect) {
        lines.push("settings: gateways/app.json".into());
        lines.push(format!(
            "stored: {}",
            value["settingsStored"].as_bool().unwrap_or(false)
        ));
        lines.push("secrets: redacted".into());
    }
    lines.join("\n")
}

pub(super) fn error(command: &str, json_output: bool, message: &str) -> ExitCode {
    if json_output {
        let code = if message.starts_with("service_restart_required: ") {
            "service_restart_required"
        } else {
            "gateway_cli_failed"
        };
        eprintln!(
            "{}",
            json!({"ok":false,"command":command,"error":{"code":code,"message":message}})
        );
    } else {
        eprintln!("{message}");
    }
    ExitCode::from(1)
}
