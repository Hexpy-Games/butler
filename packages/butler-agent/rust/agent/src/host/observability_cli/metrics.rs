use std::{
    path::Path,
    process::ExitCode,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{Value, json};

use super::{
    Command, Options, ResolvedInstallation, clamp_lines, path, report_error, report_success,
};

pub(super) async fn set_enabled(
    options: &Options,
    command: Command,
    data_root: &Path,
    installation: &ResolvedInstallation,
) -> ExitCode {
    let enabled = command == Command::MetricsEnable;
    let path = match path::safe_data_file(
        installation,
        data_root,
        &data_root.join("butler.config.json"),
    ) {
        Ok(path) => path,
        Err(message) => {
            return report_error(command.name(), options.json, "unsafe_path", &message, 1);
        }
    };
    let writes = crate::configuration::ConfigurationWrites::new();
    let _guard = writes.acquire().await;
    let mut config = match crate::configuration::read_json_object(&path) {
        Ok(config) => config,
        Err(message) => {
            return report_error(
                command.name(),
                options.json,
                "config_read_failed",
                &message,
                1,
            );
        }
    };
    if !config.get("metrics").is_some_and(Value::is_object) {
        config["metrics"] = json!({});
    }
    config["metrics"]["enabled"] = Value::Bool(enabled);
    if let Err(message) = crate::configuration::write_json_atomic(&path, &config) {
        return report_error(
            command.name(),
            options.json,
            "config_write_failed",
            &message,
            1,
        );
    }
    if options.json {
        println!("{}", json!({ "enabled": enabled, "configPath": path }));
    } else if !options.quiet {
        println!(
            "Butler metrics {}.",
            if enabled { "enabled" } else { "disabled" }
        );
    }
    ExitCode::SUCCESS
}

pub(super) fn tail(
    options: &Options,
    data_root: &Path,
    installation: &ResolvedInstallation,
) -> ExitCode {
    let command = Command::MetricsTail;
    for candidate in [
        data_root.join("butler.config.json"),
        data_root.join("metrics/operational-events.jsonl"),
    ] {
        if let Err(message) = path::safe_data_file(installation, data_root, &candidate) {
            return report_error(command.name(), options.json, "unsafe_path", &message, 1);
        }
    }
    let lines = clamp_lines(options, 20, 500);
    let since_ts = options.since_hours.and_then(|hours| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()
            .map(|duration| duration.as_millis() as f64 - hours * 3_600_000.0)
    });
    let events = crate::operations::tail_operational_metric_events(data_root, since_ts, lines);
    let enabled = crate::operations::metrics_enabled(data_root);
    let data = json!({ "events": events, "lines": lines, "enabled": enabled });
    let text = data["events"]
        .as_array()
        .into_iter()
        .flatten()
        .map(render_event)
        .collect::<Vec<_>>();
    let human = if text.is_empty() {
        "No operational metrics found.".to_owned()
    } else {
        text.join("\n")
    };
    report_success(options, command.name(), data, &human);
    ExitCode::SUCCESS
}

fn render_event(event: &Value) -> String {
    let timestamp = event["ts"]
        .as_f64()
        .map(format_iso_timestamp)
        .unwrap_or_else(|| "unknown-time".into());
    format!(
        "{timestamp} {}:{} {}",
        event["category"].as_str().unwrap_or("maintenance"),
        event["name"].as_str().unwrap_or("unknown"),
        event["status"].as_str().unwrap_or("ok")
    )
}

fn format_iso_timestamp(timestamp_ms: f64) -> String {
    let seconds = (timestamp_ms / 1_000.0).floor() as i64;
    let nanos = ((timestamp_ms - seconds as f64 * 1_000.0).max(0.0) * 1_000_000.0) as u32;
    chrono::DateTime::from_timestamp(seconds, nanos)
        .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_else(|| "unknown-time".into())
}
