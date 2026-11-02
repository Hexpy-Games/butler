//! Observe scoped commands without scanning workspace contents or rolling changes back.
use super::*;
use butler_platform::command_sandbox::CommandChanges;

pub(crate) struct TaskWriteSnapshot {
    generated: artifacts::Snapshot,
    git: Option<registered_artifacts::GitSnapshot>,
    changes: Vec<(PathBuf, Option<CommandChanges>)>,
}

impl GuidedCommand {
    pub(crate) async fn task_write_snapshot(
        &self,
        workspace: &Path,
        data: &Path,
    ) -> Result<TaskWriteSnapshot, BtccError> {
        let root = workspace.to_path_buf();
        let artifacts = data.join("artifacts/generated");
        let changes = self
            .jobs
            .run(move || {
                let mut roots = vec![(root.clone(), CommandChanges::watch(&root).ok())];
                if !artifacts.starts_with(&root) {
                    let _ = std::fs::create_dir_all(&artifacts);
                    roots.push((artifacts.clone(), CommandChanges::watch(&artifacts).ok()));
                }
                roots
            })
            .await?;
        let (generated, git) = self.scope_snapshot(workspace, data).await?;
        Ok(TaskWriteSnapshot {
            generated,
            git,
            changes,
        })
    }

    async fn scope_snapshot(
        &self,
        workspace: &Path,
        data: &Path,
    ) -> Result<
        (
            artifacts::Snapshot,
            Option<registered_artifacts::GitSnapshot>,
        ),
        BtccError,
    > {
        let data = data.to_path_buf();
        let generated = self
            .jobs
            .run(move || {
                let inventory = butler_platform::secure_fs::SecretInventory::cached(&data);
                artifacts::snapshot(&data, &inventory)
            })
            .await?;
        let git = registered_artifacts::snapshot(
            &self.commands,
            workspace,
            self.host_environment.clone(),
            CancellationToken::new(),
        )
        .await;
        Ok((generated, git))
    }

    pub(crate) async fn task_write_errors(
        &self,
        before: TaskWriteSnapshot,
        workspace: &Path,
        data: &Path,
        scopes: &[String],
    ) -> Result<Vec<String>, BtccError> {
        let (after, git) = self.scope_snapshot(workspace, data).await?;
        let mut paths = artifacts::changed(&before.generated, &after)
            .into_iter()
            .map(|p| data.join(p))
            .collect::<Vec<_>>();
        if let (Some(before), Some(after)) = (&before.git, &git) {
            paths.extend(
                registered_artifacts::changed_paths(before, after)
                    .into_iter()
                    .map(|p| workspace.join(p)),
            );
        }
        let changes = self
            .jobs
            .run(move || {
                before
                    .changes
                    .into_iter()
                    .map(|(root, watch)| (root, watch.map(CommandChanges::finish)))
                    .collect::<Vec<_>>()
            })
            .await?;
        let complete = changes
            .iter()
            .all(|(_, c)| c.as_ref().is_some_and(|c| c.complete));
        for (root, changes) in changes {
            if let Some(changes) = changes {
                paths.extend(changes.paths.into_iter().map(|p| root.join(p)));
            }
        }
        let mut errors = paths
            .into_iter()
            .filter(|path| !runtime_owned(path, data))
            .filter(|path| !inside(path, workspace, scopes))
            .map(|p| {
                format!(
                    "error: task_scope_write observed outside Task paths during run_command: {}",
                    p.display()
                )
            })
            .collect::<Vec<_>>();
        if !complete {
            errors
                .push("error: task_scope_write workspace change observation was incomplete".into());
        }
        errors.sort();
        errors.dedup();
        Ok(errors)
    }
}

fn inside(path: &Path, workspace: &Path, scopes: &[String]) -> bool {
    let Ok(relative) = path.strip_prefix(workspace) else {
        return false;
    };
    let Some(path) = butler_turn::btcc::task_path(&relative.to_string_lossy()) else {
        return false;
    };
    scopes
        .iter()
        .any(|scope| butler_turn::btcc::task_path_contains(scope, &path))
}

/// Runtime stores produce their own writes independently of a command. User
/// files in session worktrees and generated artifacts remain observable.
fn runtime_owned(path: &Path, data: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(data) else {
        return false;
    };
    if relative.starts_with("artifacts/generated")
        || relative.starts_with(butler_platform::data_paths::WORKTREES)
    {
        return false;
    }
    let Some(first) = relative.components().next() else {
        return false;
    };
    butler_platform::data_paths::OWNED_PATHS
        .iter()
        .any(|owned| Path::new(owned).components().next() == Some(first))
}
