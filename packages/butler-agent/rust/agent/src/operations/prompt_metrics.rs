//! Synchronous source-compatible usage persistence, one invocation at a time.

mod event;

use std::fs::{OpenOptions, create_dir_all};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::btcc::ModelRoundError;
use crate::models::{PromptUsageMetricInput, PromptUsageMetricSink, ProviderClock};

pub(crate) struct PromptUsageMetrics {
    data_root: PathBuf,
    clock: Arc<dyn ProviderClock>,
}

impl PromptUsageMetrics {
    pub(crate) fn new(data_root: PathBuf, clock: Arc<dyn ProviderClock>) -> Self {
        Self { data_root, clock }
    }
}

impl PromptUsageMetricSink for PromptUsageMetrics {
    fn append(&self, input: PromptUsageMetricInput<'_>) -> Result<(), ModelRoundError> {
        let Some(prompt_tokens) = input.prompt_tokens else {
            return Ok(());
        };
        if !prompt_tokens.is_finite()
            || prompt_tokens < 0.0
            || !input.cached_tokens.is_finite()
            || input.total_tokens.is_some_and(|value| !value.is_finite())
        {
            return Ok(());
        }
        // Source object evaluation samples time before the optional budget getter.
        // Neither is evaluated for invalid usage and getter failures write no row.
        let timestamp = self.clock.now_epoch_millis();
        let attribution = input.usage_attribution;
        let snapshot = attribution
            .and_then(|value| value.budget_state_source)
            .map(|source| source.snapshot())
            .transpose()?
            .flatten();
        let budget = snapshot
            .as_ref()
            .or_else(|| attribution.and_then(|value| value.budget_state));
        let mut line = event::line(&input, timestamp, prompt_tokens, budget)?;
        line.push('\n');
        let data_root = input.butler_data.map(Path::new).unwrap_or(&self.data_root);
        let directory = data_root.join("metrics");
        create_dir_all(&directory).map_err(io_failure)?;
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(directory.join("prompt-cache-usage.jsonl"))
            .map_err(io_failure)?;
        file.write_all(line.as_bytes()).map_err(io_failure)
    }
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
