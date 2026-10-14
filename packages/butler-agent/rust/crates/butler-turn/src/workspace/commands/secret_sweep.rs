//! Finish project containment on all exit paths, including cancellation.
use std::path::{Path, PathBuf};

use super::{CommandError, GuidedAccess, GuidedCommandInput, GuidedCommandOutput};

pub(super) struct Prepared {
    paths: Vec<PathBuf>,
    _lease: Option<butler_platform::command_sandbox::ProjectWritePreparation>,
}

impl Prepared {
    fn sweep(self, root: &Path, data: &Path) -> std::io::Result<Vec<PathBuf>> {
        butler_platform::command_sandbox::reconcile_project_write(data)?;
        butler_platform::command_sandbox::sweep_new_secrets(root, &self.paths, data)
    }
}

impl std::ops::Deref for Prepared {
    type Target = [PathBuf];
    fn deref(&self) -> &Self::Target {
        &self.paths
    }
}

pub(super) async fn before_run(input: &GuidedCommandInput) -> Result<Prepared, CommandError> {
    if input.access != GuidedAccess::ProjectWrite {
        return Ok(Prepared {
            paths: Vec::new(),
            _lease: None,
        });
    }
    let root = input.workspace_root.clone();
    let data = input.butler_data.clone();
    tokio::task::spawn_blocking(move || {
        let lease = butler_platform::command_sandbox::prepare_project_write(&root, &data)?;
        let paths = butler_platform::command_sandbox::discover_project_secrets(&root)?;
        Ok(Prepared {
            paths,
            _lease: Some(lease),
        })
    })
    .await
    .map_err(|error| CommandError::io(std::io::Error::other(error)))?
    .map_err(CommandError::io)
}

pub(super) async fn after_run(
    input: &GuidedCommandInput,
    since: Prepared,
    outcome: Result<Option<GuidedCommandOutput>, CommandError>,
) -> Result<Option<GuidedCommandOutput>, CommandError> {
    if input.access != GuidedAccess::ProjectWrite {
        return outcome;
    }
    let root = input.workspace_root.clone();
    let data = input.butler_data.clone();
    let swept = tokio::task::spawn_blocking(move || since.sweep(&root, &data))
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
