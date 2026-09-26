//! Explicit one-shot tool-output and metric retention.

use std::{
    path::Path,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{Value, json};

use crate::{context::PruneToolOutputInput, operations::MetricFiles};

use super::{
    CliError, ResolvedInstallation, context_budget_owner, open_status_models, unavailable,
    validate_write_destination,
};

const DAY_MS: f64 = 24.0 * 60.0 * 60.0 * 1_000.0;
const TOOL_OUTPUT_MAX_AGE_MS: f64 = 30.0 * DAY_MS;
const TOOL_OUTPUT_MAX_BYTES: f64 = 512.0 * 1024.0 * 1024.0;
const METRIC_MAX_AGE_MS: f64 = 90.0 * DAY_MS;

pub(super) async fn run(
    data_root: &Path,
    installation: &ResolvedInstallation,
) -> Result<(Value, String), CliError> {
    validate_prune_destinations(data_root, installation)?;
    let models = open_status_models(data_root).await?;
    let budget_owner = Arc::new(context_budget_owner(&models));
    let metrics = Arc::new(MetricFiles::new(data_root.to_path_buf()));
    let tool_output = super::super::native_tool_output(
        data_root.to_path_buf(),
        budget_owner,
        Arc::clone(&metrics),
    );
    let artifacts = async {
        let completion = tool_output
            .submit_prune(PruneToolOutputInput {
                max_age_ms: Some(TOOL_OUTPUT_MAX_AGE_MS),
                max_bytes: Some(TOOL_OUTPUT_MAX_BYTES),
                protected_paths: Vec::new(),
                record_telemetry: true,
            })
            .await
            .map_err(|error| unavailable("native_context_prune_failed", error.to_string()))?;
        completion
            .await
            .map_err(|error| {
                unavailable("native_context_prune_completion_lost", error.to_string())
            })?
            .map_err(|error| unavailable("native_context_prune_failed", error.to_string()))
    }
    .await;
    tool_output.close().await;
    let artifacts = artifacts?;

    let metrics_owner = Arc::clone(&metrics);
    let now_ms = now_epoch_millis();
    let retained =
        tokio::task::spawn_blocking(move || metrics_owner.retain(now_ms, METRIC_MAX_AGE_MS))
            .await
            .map_err(|error| {
                unavailable("native_context_metric_retention_failed", error.to_string())
            })?
            .map_err(|error| {
                unavailable("native_context_metric_retention_failed", error.to_string())
            })?;
    let data = json!({
        "ok": true,
        "butlerData": data_root,
        "artifacts": {
            "scanned": artifacts.scanned,
            "deleted": artifacts.deleted,
            "bytesDeleted": artifacts.bytes_deleted,
            "remainingBytes": artifacts.remaining_bytes,
            "maxAgeMs": artifacts.max_age_ms,
            "maxBytes": artifacts.max_bytes,
            "rawTextStored": false,
        },
        "metrics": {
            "scanned": retained.totals.scanned,
            "kept": retained.totals.kept,
            "deleted": retained.totals.deleted,
            "parseErrors": retained.totals.parse_errors,
        },
        "privacy": { "rawTextStored": false },
    });
    let human = format!(
        "Context maintenance prune complete.\nArtifacts deleted={} bytesDeleted={}\nMetrics deleted={} parseErrors={}",
        artifacts.deleted,
        artifacts.bytes_deleted,
        retained.totals.deleted,
        retained.totals.parse_errors,
    );
    Ok((data, human))
}

fn validate_prune_destinations(
    data_root: &Path,
    installation: &ResolvedInstallation,
) -> Result<(), CliError> {
    let artifacts_dir = data_root.join("artifacts");
    let tool_output_dir = artifacts_dir.join("tool-output");
    let metrics_dir = data_root.join("metrics");
    for directory in [&artifacts_dir, &tool_output_dir, &metrics_dir] {
        validate_write_destination(installation, directory, false)?;
    }
    for file_name in [
        "context-monitor.jsonl",
        "context-compaction.jsonl",
        "tool-output-prune.jsonl",
        "operational-events.jsonl",
    ] {
        validate_write_destination(installation, &metrics_dir.join(file_name), true)?;
    }
    Ok(())
}

fn now_epoch_millis() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        * 1_000.0
}
