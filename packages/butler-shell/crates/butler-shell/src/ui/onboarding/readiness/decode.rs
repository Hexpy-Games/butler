//! `normalizeReadiness`: the Agent's readiness answer as a [`ReadinessView`].
use gpui::SharedString;
use serde_json::Value;

use super::{MemoryModel, ReadinessStatus, ReadinessView};

const STEP_STATUSES: [&str; 4] = ["pending", "running", "done", "failed"];
const MODEL_STATES: [&str; 7] = [
    "unset",
    "off",
    "queued",
    "downloading",
    "verifying",
    "ready",
    "failed",
];

impl ReadinessStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Preparing => "preparing",
            Self::Ready => "ready",
            Self::Failed => "failed",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        [Self::Preparing, Self::Ready, Self::Failed]
            .into_iter()
            .find(|status| status.as_str() == text)
    }
}

impl ReadinessView {
    /// A validated view of a `/setup/readiness` (or retry, or memory-model) answer; `None` for
    /// anything else. Each step is `(id, status)`.
    pub(crate) fn from_value(raw: &Value) -> Option<Self> {
        let status = ReadinessStatus::parse(raw.get("status")?.as_str()?)?;
        let mut steps = Vec::new();
        let mut error_code = None;
        let mut done = 0;
        for step in raw
            .get("steps")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let (Some(id), Some(state)) = (
                step.get("id").and_then(Value::as_str),
                step.get("status").and_then(Value::as_str),
            ) else {
                continue;
            };
            if !STEP_STATUSES.contains(&state) {
                continue;
            }
            done += usize::from(state == "done");
            if state == "failed" && error_code.is_none() {
                error_code = step
                    .pointer("/error/code")
                    .and_then(Value::as_str)
                    .map(SharedString::from);
            }
            steps.push((
                SharedString::from(id.to_owned()),
                SharedString::from(state.to_owned()),
            ));
        }
        Some(Self {
            status,
            done,
            total: steps.len(),
            steps,
            error_code,
            memory_model: raw.get("memory_model").and_then(model),
        })
    }
}

#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "whole byte counts"
)]
fn model(raw: &Value) -> Option<MemoryModel> {
    let state = raw.get("state")?.as_str()?;
    if !MODEL_STATES.contains(&state) {
        return None;
    }
    Some(MemoryModel {
        state: SharedString::from(state.to_owned()),
        bytes_done: raw.get("bytes_done")?.as_f64()? as u64,
        bytes_total: raw.get("bytes_total")?.as_f64()? as u64,
        reason: raw
            .get("reason")
            .and_then(Value::as_str)
            .map(|reason| SharedString::from(reason.to_owned())),
    })
}
