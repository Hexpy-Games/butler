use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    process::ExitCode,
    time::Duration,
};

use serde_json::{Value, json};

use crate::{
    host::{ResolvedInstallation, installation::realpath_or_nearest},
    operations::{LogEntry, LogFile, LogFollower, tail_log_entries},
};

pub(super) fn read(
    data_root: &Path,
    installation: &ResolvedInstallation,
    requested_lines: Option<usize>,
    follow: bool,
) -> Result<Value, String> {
    let files = select_files(data_root, installation)?;
    let limit = match requested_lines.unwrap_or(80) {
        0 => usize::MAX,
        lines => lines.min(1_000),
    };
    let lines =
        tail_log_entries(&files, limit).map_err(|_| "native_gateway_log_read_failed".to_owned())?;
    Ok(json!({
        "gateway":"app",
        "files":files.iter().map(|file| &file.name).collect::<Vec<_>>(),
        "lines":lines.iter().map(entry_json).collect::<Vec<_>>(),
        "follow":follow,
    }))
}

pub(super) async fn follow(data_root: &Path, installation: &ResolvedInstallation) -> ExitCode {
    let files = match select_files(data_root, installation) {
        Ok(files) => files,
        Err(message) => return report_error(&message),
    };
    let Ok(mut follower) = LogFollower::from_end(&files) else {
        return report_error("App gateway logs could not be followed.");
    };
    let Ok(mut interrupt) =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
    else {
        return report_error("Log follow signal handling is unavailable.");
    };
    let Ok(mut terminate) =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
    else {
        return report_error("Log follow signal handling is unavailable.");
    };
    let mut interval = tokio::time::interval(follow_poll_interval());
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    interval.tick().await;
    loop {
        tokio::select! {
            _ = interrupt.recv() => return stop_follow(&mut follower),
            _ = terminate.recv() => return stop_follow(&mut follower),
            _ = interval.tick() => {
                for path in follower.paths() {
                    if let Err(message) = safe_log_file(installation, data_root, path) {
                        return report_error(&message);
                    }
                }
                match follower.poll() {
                    Ok(lines) => {
                        if write_lines(&lines).is_err() {
                            return report_error("Log output could not be written.");
                        }
                    }
                    Err(_) => return report_error("App gateway logs could not be followed."),
                }
            }
        }
    }
}

fn select_files(
    data_root: &Path,
    installation: &ResolvedInstallation,
) -> Result<Vec<LogFile>, String> {
    let mut files = Vec::new();
    for name in [
        "butler-agent-service.stdout.log",
        "butler-agent-service.stderr.log",
    ] {
        let requested = data_root.join("logs").join(name);
        let path = safe_log_file(installation, data_root, &requested)?;
        match fs::metadata(&path) {
            Ok(metadata) if metadata.is_file() => files.push(LogFile {
                path,
                name: name.to_owned(),
            }),
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => return Err("native_gateway_log_read_failed".into()),
        }
    }
    Ok(files)
}

fn safe_log_file(
    installation: &ResolvedInstallation,
    data_root: &Path,
    requested: &Path,
) -> Result<PathBuf, String> {
    if !requested.starts_with(data_root) {
        return Err("path must remain inside DATA".into());
    }
    let parent = requested
        .parent()
        .ok_or_else(|| "path parent is unavailable".to_owned())?;
    let parent_real = realpath_or_nearest(parent).map_err(|_| "path parent is unavailable")?;
    let target_real = realpath_or_nearest(requested).map_err(|_| "path target is unavailable")?;
    if !parent_real.starts_with(data_root) || !target_real.starts_with(data_root) {
        return Err("path aliases outside DATA".into());
    }
    installation
        .validate_data_root(&target_real)
        .map_err(|_| "path overlaps the installation".to_owned())?;
    Ok(requested.to_path_buf())
}

fn entry_json(entry: &LogEntry) -> Value {
    json!({"file":entry.file,"text":entry.text})
}

fn stop_follow(follower: &mut LogFollower) -> ExitCode {
    if write_lines(&follower.flush_pending()).is_err() {
        return report_error("Log output could not be written.");
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

fn report_error(message: &str) -> ExitCode {
    eprintln!("{message}");
    ExitCode::from(1)
}
