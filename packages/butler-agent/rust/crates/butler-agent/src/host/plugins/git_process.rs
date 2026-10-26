//! Bounded git commands, run only on blocking workers.
use super::{Result, error};
use butler_platform::process_control::{self, GroupSignal};
use std::{
    process::{Command, Output},
    sync::mpsc,
    time::Duration,
};

pub(super) fn output(mut command: Command, operation: Option<&str>) -> Result<Output> {
    let network = matches!(operation, Some("fetch" | "clone"));
    // Operators may shorten the hang detector for their host; invalid values use defaults.
    let seconds = std::env::var("BUTLER_PLUGIN_GIT_TIMEOUT_SECS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|s| *s > 0)
        .unwrap_or(120)
        .min(if network { 120 } else { 15 });
    process_control::isolate_group(&mut command);
    command.stdout(std::process::Stdio::piped());
    let mut child = command.spawn().map_err(|_| error("plugin_git_failed"))?;
    let pid = child.id();
    if process_control::contain_std(&child).is_err() {
        let _ = process_control::signal_group(pid, GroupSignal::Kill);
        let _ = child.kill();
        let _ = child.wait();
        return Err(error("plugin_git_failed"));
    }
    let (send, receive) = mpsc::sync_channel(1);
    let waiter = std::thread::spawn(move || {
        let _ = send.send(child.wait_with_output());
    });
    let result = receive.recv_timeout(Duration::from_secs(seconds));
    // Also release Windows containment and stop descendants retaining output pipes.
    let _ = process_control::signal_group(pid, GroupSignal::Kill);
    let _ = waiter.join();
    match result {
        Ok(output) => output.map_err(|_| error("plugin_git_failed")),
        Err(mpsc::RecvTimeoutError::Timeout) => Err(error("plugin_git_timeout")),
        Err(_) => Err(error("plugin_git_failed")),
    }
}
