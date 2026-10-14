//! Finish project containment on all exit paths, including cancellation.
use std::path::PathBuf;

use super::{CommandError, GuidedAccess, GuidedCommandInput, GuidedCommandOutput};

pub(super) async fn before_run(input: &GuidedCommandInput) -> Result<Vec<PathBuf>, CommandError> {
    if input.access != GuidedAccess::ProjectWrite {
        return Ok(Vec::new());
    }
    let root = input.workspace_root.clone();
    tokio::task::spawn_blocking(move || {
        butler_platform::command_sandbox::discover_project_secrets(&root)
    })
    .await
    .map_err(|error| CommandError::io(std::io::Error::other(error)))?
    .map_err(CommandError::io)
}

pub(super) async fn after_run(
    input: &GuidedCommandInput,
    since: Vec<PathBuf>,
    outcome: Result<Option<GuidedCommandOutput>, CommandError>,
) -> Result<Option<GuidedCommandOutput>, CommandError> {
    if input.access != GuidedAccess::ProjectWrite {
        return outcome;
    }
    let root = input.workspace_root.clone();
    let data = input.butler_data.clone();
    let swept = tokio::task::spawn_blocking(move || {
        butler_platform::command_sandbox::reconcile_project_write(&data)?;
        butler_platform::command_sandbox::sweep_new_secrets(&root, &since, &data)
    })
    .await
    .map_err(|error| CommandError::io(std::io::Error::other(error)))
    .and_then(|result| result.map_err(CommandError::io));
    let violations = match swept {
        Ok(paths) => paths,
        Err(error) => {
            if let Ok(Some(output)) = outcome {
                let _ = tokio::fs::remove_file(output.payload_source.path).await;
            }
            return Err(error);
        }
    };
    outcome.map(|output| {
        output.map(|mut output| {
            output.summary.sandbox_violation = violations;
            output
        })
    })
}
