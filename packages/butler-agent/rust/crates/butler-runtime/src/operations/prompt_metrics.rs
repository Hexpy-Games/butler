//! Synchronous source-compatible usage persistence, one invocation at a time.

mod event;

use std::fs::{OpenOptions, create_dir_all};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use butler_models::models::{PromptUsageMetricInput, PromptUsageMetricSink, ProviderClock};
use butler_turn::btcc::ModelRoundError;

pub struct PromptUsageMetrics {
    data_root: PathBuf,
    clock: Arc<dyn ProviderClock>,
}

impl PromptUsageMetrics {
    pub fn new(data_root: PathBuf, clock: Arc<dyn ProviderClock>) -> Self {
        Self { data_root, clock }
    }
}

impl PromptUsageMetricSink for PromptUsageMetrics {
    fn append_request_diagnostic(
        &self,
        diagnostic: &serde_json::Value,
        data: Option<&str>,
    ) -> Result<(), ModelRoundError> {
        let data_root = data.map(Path::new).unwrap_or(&self.data_root);
        write_diagnostic(data_root, diagnostic, self.clock.now_epoch_millis())
    }

    fn append(&self, input: PromptUsageMetricInput<'_>) -> Result<(), ModelRoundError> {
        if input.prompt_tokens.is_none() && input.prefix_diagnostics.is_none() {
            return Ok(());
        }
        if input
            .prompt_tokens
            .is_some_and(|value| !value.is_finite() || value < 0.0)
            || !input.cached_tokens.is_finite()
            || input.total_tokens.is_some_and(|value| !value.is_finite())
        {
            return Ok(());
        }
        // Source object evaluation samples time before the optional budget getter.
        // Neither is evaluated for invalid usage and getter failures write no row.
        let timestamp = self.clock.now_epoch_millis();
        let attribution = input.usage_attribution;
        #[expect(
            clippy::redundant_closure_for_method_calls,
            reason = "the budget-source trait is private to models"
        )]
        let snapshot = attribution
            .and_then(|value| value.budget_state_source)
            .map(|source| source.snapshot())
            .transpose()?
            .flatten();
        let budget = snapshot
            .as_ref()
            .or_else(|| attribution.and_then(|value| value.budget_state));
        let data_root = input.butler_data.map(Path::new).unwrap_or(&self.data_root);
        let directory = data_root.join("metrics");
        create_dir_all(&directory).map_err(io_failure)?;
        if let Some(prefix) = input.prefix_diagnostics.filter(|value| !value.is_null()) {
            write_diagnostic(data_root, prefix, timestamp)?;
        }
        let mut line = event::line(&input, timestamp, input.prompt_tokens, budget)?;
        line.push('\n');
        append_line(&directory.join("prompt-cache-usage.jsonl"), &line)
    }
}

fn write_diagnostic(
    data_root: &Path,
    prefix: &serde_json::Value,
    timestamp: i64,
) -> Result<(), ModelRoundError> {
    let directory = data_root.join("metrics");
    create_dir_all(&directory).map_err(io_failure)?;
    let mut diagnostic = prefix.clone();
    diagnostic["ts"] = timestamp.into();
    let mut encoded = butler_core::json::stringify(&diagnostic).map_err(|error| {
        ModelRoundError::InvocationFailure {
            code: Some("request_diagnostic_encoding_failed".into()),
            message: error.to_string(),
        }
    })?;
    encoded.push('\n');
    append_line(
        &directory.join("request-prefix-diagnostics.jsonl"),
        &encoded,
    )
}

fn append_line(path: &Path, line: &str) -> Result<(), ModelRoundError> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(io_failure)?;
    file.write_all(line.as_bytes()).map_err(io_failure)
}

#[expect(
    clippy::needless_pass_by_value,
    reason = "map_err/iterator adapter taking owned values"
)]
fn io_failure(error: std::io::Error) -> ModelRoundError {
    ModelRoundError::InvocationFailure {
        code: error.raw_os_error().map(|value| value.to_string()),
        message: error.to_string(),
    }
}

#[cfg(test)]
mod tests;
