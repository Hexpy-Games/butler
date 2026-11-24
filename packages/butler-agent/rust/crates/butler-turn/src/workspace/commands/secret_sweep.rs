//! Finish project containment on all exit paths, including cancellation.
use std::path::{Path, PathBuf};

use butler_platform::command_sandbox::{self, ProjectEntries};

use super::{CommandError, GuidedAccess, GuidedCommandInput, GuidedCommandOutput};

pub(super) struct Prepared {
    roots: Vec<(PathBuf, ProjectEntries)>,
    paths: Vec<PathBuf>,
    lease: Option<butler_platform::command_sandbox::ProjectWritePreparation>,
}

impl Prepared {
    fn sweep(
        self,
        data: &Path,
        inventory: &butler_platform::secure_fs::SecretInventory,
    ) -> std::io::Result<Vec<PathBuf>> {
        let mut violations = Vec::new();
        let mut first_error = None;
        for (root, entries) in self.roots {
            match command_sandbox::sweep_with_inventory(&root, &entries, data, inventory) {
                Ok(paths) => violations.extend(paths),
                Err(error) => {
                    first_error.get_or_insert(error);
                }
            }
        }
        if let Some(lease) = self.lease {
            lease.release();
        }
        if let Err(error) = butler_platform::command_sandbox::reconcile_project_write(data) {
            eprintln!("Project write reconciliation failed: {error}");
        }
        first_error.map_or(Ok(violations), Err)
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
            roots: Vec::new(),
            paths: Vec::new(),
            lease: None,
        });
    }
    let root = input.workspace_root.clone();
    let extra = input.extra_write_roots.clone();
    let data = input.butler_data.clone();
    tokio::task::spawn_blocking(move || {
        let lease = butler_platform::command_sandbox::prepare_project_write(&root, &data)?;
        let roots = std::iter::once(root)
            .chain(extra)
            .map(|root| {
                let entries = command_sandbox::discover_project_entries(&root)?;
                Ok((root, entries))
            })
            .collect::<std::io::Result<Vec<_>>>()?;
        let paths = roots
            .iter()
            .flat_map(|(_, entries)| entries.iter().cloned())
            .collect();
        Ok(Prepared {
            roots,
            paths,
            lease: Some(lease),
        })
    })
    .await
    .map_err(|error| CommandError::io(std::io::Error::other(error)))?
    .map_err(|error: std::io::Error| {
        if error.kind() == std::io::ErrorKind::WouldBlock {
            CommandError::new(
                super::CommandCode::CommandObservationIsolationUnavailable,
                error.to_string(),
            )
        } else {
            CommandError::io(error)
        }
    })
}

pub(super) async fn after_run(
    input: &GuidedCommandInput,
    since: Prepared,
    outcome: Result<Option<GuidedCommandOutput>, CommandError>,
) -> Result<Option<GuidedCommandOutput>, CommandError> {
    if input.access != GuidedAccess::ProjectWrite {
        return outcome;
    }
    let data = input.butler_data.clone();
    let environment = input.host_environment.clone();
    let swept = tokio::task::spawn_blocking(move || {
        let inventory =
            butler_platform::secure_fs::SecretInventory::for_environment(&data, &environment);
        since.sweep(&data, &inventory)
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
