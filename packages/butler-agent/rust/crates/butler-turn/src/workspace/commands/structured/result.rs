use std::time::{Duration, SystemTime};

use crate::workspace::commands::{CommandError, StructuredCommandOutput};

pub(super) fn pipeline_exit(statuses: &[Option<std::process::ExitStatus>]) -> Option<i32> {
    statuses
        .iter()
        .rev()
        .filter_map(|status| status.as_ref().and_then(std::process::ExitStatus::code))
        .find(|code| *code != 0)
        .or_else(|| {
            statuses
                .last()
                .and_then(|status| status.as_ref().and_then(std::process::ExitStatus::code))
        })
}

pub(super) fn bounded_timeout(value: Option<f64>) -> Duration {
    let value = value.filter(|value| value.is_finite()).unwrap_or(30_000.0);
    Duration::from_millis(butler_core::json::saturating_u64(
        value.trunc().clamp(1.0, 3_600_000.0),
    ))
}

/// Why a pipeline stopped before its steps settled on their own.
#[derive(Clone, Copy, Debug, Default)]
pub(super) struct Stop {
    pub(super) timed_out: bool,
    pub(super) cancelled: bool,
}

impl Stop {
    pub(super) fn interrupted(self) -> bool {
        self.timed_out || self.cancelled
    }
}

/// Decoded stdout and stderr text of a pipeline.
#[derive(Default)]
pub(super) struct Captured {
    pub(super) stdout: String,
    pub(super) stderr: String,
}

pub(super) fn result(
    started: SystemTime,
    captured: Captured,
    exit_code: Option<i32>,
    stop: Stop,
    error: Option<CommandError>,
) -> StructuredCommandOutput {
    StructuredCommandOutput {
        stdout: captured.stdout,
        stderr: captured.stderr,
        exit_code,
        timed_out: stop.timed_out,
        cancelled: stop.cancelled,
        duration_ms: u64::try_from(
            SystemTime::now()
                .duration_since(started)
                .unwrap_or_default()
                .as_millis()
                .min(u128::from(u64::MAX)),
        )
        .unwrap_or(u64::MAX),
        error,
    }
}

/// A pipeline that failed before producing output.
pub(super) fn failed(started: SystemTime, error: CommandError) -> StructuredCommandOutput {
    result(
        started,
        Captured::default(),
        None,
        Stop::default(),
        Some(error),
    )
}
