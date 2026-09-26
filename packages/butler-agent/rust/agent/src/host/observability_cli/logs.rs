use std::{
    io::{self, Write},
    path::{Path, PathBuf},
    process::ExitCode,
    time::Duration,
};

use serde_json::json;

use super::{Options, ResolvedInstallation, clamp_lines, path, report_error, report_success};
use crate::operations::{LogEntry, LogFile, LogFollower, tail_log_entries};

pub(super) async fn run(
    options: Options,
    data_root: PathBuf,
    installation: ResolvedInstallation,
) -> ExitCode {
    let service = options
        .service
        .clone()
        .filter(|service| !service.is_empty())
        .unwrap_or_else(|| "butler-main".into());
    let files = match select_files(&service, &data_root, &installation) {
        Ok(files) => files,
        Err(message) => {
            return report_error("butler logs", options.json, "unsafe_path", &message, 1);
        }
    };
    let files: Vec<_> = files
        .into_iter()
        .filter(|entry| entry.path.is_file())
        .collect();
    if files.is_empty() {
        let message = format!("no logs found for service {service}");
        return report_error("butler logs", options.json, "not_found", &message, 1);
    }
    let lines = match tail_log_entries(&files, clamp_lines(&options, 80, 1_000)) {
        Ok(lines) => lines,
        Err(_) => {
            return report_error(
                "butler logs",
                options.json,
                "log_read_failed",
                "Log files could not be read.",
                1,
            );
        }
    };
    let data = json!({
        "service": service,
        "files": files.iter().map(|file| &file.path).collect::<Vec<_>>(),
        "lines": lines.iter().map(entry_json).collect::<Vec<_>>(),
        "follow": options.follow,
    });
    let human = if lines.is_empty() {
        "No log lines found.".to_owned()
    } else {
        render_lines(&lines)
    };
    report_success(&options, "butler logs", &data, &human);
    if !options.follow || options.json || options.quiet {
        return ExitCode::SUCCESS;
    }
    follow(data_root, installation, files).await
}

fn select_files(
    service: &str,
    data_root: &Path,
    installation: &ResolvedInstallation,
) -> Result<Vec<LogFile>, String> {
    let names = match service {
        "butler-main" | "butler-agent-native" | "butler-agent-service" => vec![
            "butler-agent-service.stdout.log".to_owned(),
            "butler-agent-service.stderr.log".to_owned(),
        ],
        _ => vec![
            format!("{service}-out.log"),
            format!("{service}-err.log"),
            format!("{service}.log"),
        ],
    };
    names
        .into_iter()
        .map(|name| {
            let requested = data_root.join("logs").join(&name);
            let path = path::safe_data_file(installation, data_root, &requested)?;
            Ok(LogFile { path, name })
        })
        .collect()
}

fn entry_json(entry: &LogEntry) -> serde_json::Value {
    json!({ "file": entry.file, "text": entry.text })
}

fn render_lines(lines: &[LogEntry]) -> String {
    lines
        .iter()
        .map(|line| format!("[{}] {}", line.file, line.text))
        .collect::<Vec<_>>()
        .join("\n")
}

async fn follow(
    data_root: PathBuf,
    installation: ResolvedInstallation,
    files: Vec<LogFile>,
) -> ExitCode {
    let mut follower = match LogFollower::from_end(&files) {
        Ok(follower) => follower,
        Err(_) => {
            return report_error(
                "butler logs",
                false,
                "log_read_failed",
                "Log files could not be followed.",
                1,
            );
        }
    };
    let mut interrupt =
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt()) {
            Ok(signal) => signal,
            Err(_) => {
                return report_error(
                    "butler logs",
                    false,
                    "signal_unavailable",
                    "Log follow signal handling is unavailable.",
                    1,
                );
            }
        };
    let mut terminate =
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(signal) => signal,
            Err(_) => {
                return report_error(
                    "butler logs",
                    false,
                    "signal_unavailable",
                    "Log follow signal handling is unavailable.",
                    1,
                );
            }
        };
    let mut interval = tokio::time::interval(follow_poll_interval());
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    interval.tick().await;
    loop {
        tokio::select! {
            _ = interrupt.recv() => return stop_follow(&mut follower),
            _ = terminate.recv() => return stop_follow(&mut follower),
            _ = interval.tick() => {
                for file in follower.paths() {
                    if let Err(message) = path::safe_data_file(&installation, &data_root, file) {
                        return report_error("butler logs", false, "unsafe_path", &message, 1);
                    }
                }
                match follower.poll() {
                    Ok(lines) => {
                        if write_lines(&lines).is_err() {
                            return report_error("butler logs", false, "log_output_failed", "Log output could not be written.", 1);
                        }
                    }
                    Err(_) => return report_error("butler logs", false, "log_read_failed", "Log files could not be followed.", 1),
                }
            }
        }
    }
}

fn stop_follow(follower: &mut LogFollower) -> ExitCode {
    if write_lines(&follower.flush_pending()).is_err() {
        return report_error(
            "butler logs",
            false,
            "log_output_failed",
            "Log output could not be written.",
            1,
        );
    }
    ExitCode::SUCCESS
}

fn write_lines(lines: &[LogEntry]) -> io::Result<()> {
    let mut stdout = io::stdout().lock();
    for line in lines {
        writeln!(stdout, "[{}] {}", line.file, line.text)?;
    }
    stdout.flush()
}

fn follow_poll_interval() -> Duration {
    let milliseconds = std::env::var("BUTLER_LOG_FOLLOW_POLL_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value >= 10)
        .unwrap_or(500);
    Duration::from_millis(milliseconds)
}
