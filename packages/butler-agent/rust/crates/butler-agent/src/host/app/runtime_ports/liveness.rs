//! Source queue-owner incarnation and OS-process liveness policy.

use butler_gateway::gateway::AppQueueOwnerLiveness;
use butler_platform::process_control::{self, Liveness};

pub(crate) struct AppQueueOwnerLivenessAdapter;

impl AppQueueOwnerLiveness for AppQueueOwnerLivenessAdapter {
    fn definitely_dead(&self, owner: &str, current_owner: &str) -> bool {
        let Some((pid, incarnation)) = parse(owner) else {
            return false;
        };
        if let Some((current_pid, current_incarnation)) = parse(current_owner)
            && current_pid == pid
            && let (Some(incarnation), Some(current_incarnation)) =
                (incarnation, current_incarnation)
        {
            // The active AppApplication retains only its own owner identity.
            return incarnation != current_incarnation;
        }
        process_control::liveness(pid) == Liveness::Gone
    }
}

fn parse(value: &str) -> Option<(u32, Option<&str>)> {
    let mut parts = value.split(':');
    if parts.next()? != "app-session-queue" {
        return None;
    }
    let pid_text = parts.next()?;
    if pid_text.is_empty() || !pid_text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let pid = pid_text
        .parse::<i32>()
        .ok()
        .filter(|pid| *pid > 0)
        .and_then(|pid| u32::try_from(pid).ok())?;
    let nonce = parts.next().filter(|nonce| !nonce.is_empty())?;
    let fourth = parts.next();
    if parts.next().is_some() {
        return None;
    }
    if fourth.is_some_and(str::is_empty) {
        return None;
    }
    Some((pid, fourth.map(|_| nonce)))
}
