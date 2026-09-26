use std::time::{Duration, SystemTime};

use crate::workspace::commands::{CommandError, StructuredCommandOutput};

pub(super) fn pipeline_exit(statuses: &[Option<std::process::ExitStatus>]) -> Option<i32> {
    statuses
        .iter()
        .rev()
        .filter_map(|status| status.as_ref().and_then(|status| status.code()))
        .find(|code| *code != 0)
        .or_else(|| {
            statuses
                .last()
                .and_then(|status| status.as_ref().and_then(|status| status.code()))
        })
}

pub(super) fn bounded_timeout(value: Option<f64>) -> Duration {
    let value = value.filter(|value| value.is_finite()).unwrap_or(30_000.0);
    Duration::from_millis(crate::json::saturating_u64(
        value.trunc().clamp(1.0, 3_600_000.0),
    ))
}

pub(super) fn result(
    started: SystemTime,
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    timed_out: bool,
    cancelled: bool,
    error: Option<CommandError>,
) -> StructuredCommandOutput {
    StructuredCommandOutput {
        stdout,
        stderr,
        exit_code,
        timed_out,
        cancelled,
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
