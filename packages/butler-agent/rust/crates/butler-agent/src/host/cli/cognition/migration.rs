use std::sync::Arc;

use serde_json::Value;

use butler_memory::cognition::CognitionNamespaceMigrationService;
use butler_memory::cognition::CognitionPathEnvironment;
use butler_memory::coordination::CognitionWriteCoordinator;

use super::CliError;

pub(super) async fn run(
    data_root: std::path::PathBuf,
    paths: CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    _status: bool,
    dry_run: bool,
    apply: bool,
) -> Result<(Value, String), CliError> {
    let service = CognitionNamespaceMigrationService::new(data_root, paths, coordinator);
    if apply {
        let manifest = service
            .apply()
            .await
            .map_err(|error| CliError::failed(error.code(), error.message()))?;
        if matches!(manifest.status.as_str(), "conflict" | "failed") {
            return Err(CliError::failed(
                "invalid_state",
                format!(
                    "cognition migration {}: {}",
                    manifest.status,
                    manifest.conflicts.join("; ")
                ),
            ));
        }
        let data = serde_json::to_value(&manifest).map_err(|source| {
            CliError::failed(
                "invalid_output",
                "Could not serialize Cognition migration result",
            )
            .with_source(source)
        })?;
        return Ok((
            data,
            format!(
                "Cognition migration applied: moved={}",
                manifest.moved_paths.len()
            ),
        ));
    }
    let mut plan = service
        .plan()
        .await
        .map_err(|error| CliError::failed(error.code(), error.message()))?;
    plan.dry_run = dry_run;
    let human = format!(
        "status={}\nlegacyFiles={} legacyBytes={}\ncognitionFiles={} cognitionBytes={}{}",
        plan.status,
        plan.legacy_file_count,
        plan.legacy_byte_count,
        plan.cognition_memory_file_count,
        plan.cognition_memory_byte_count,
        if plan.conflicts.is_empty() {
            String::new()
        } else {
            format!("\nconflicts={}", plan.conflicts.join("; "))
        },
    );
    let data = serde_json::to_value(&plan).map_err(|source| {
        CliError::failed(
            "invalid_output",
            "Could not serialize Cognition migration plan",
        )
        .with_source(source)
    })?;
    Ok((data, human))
}
