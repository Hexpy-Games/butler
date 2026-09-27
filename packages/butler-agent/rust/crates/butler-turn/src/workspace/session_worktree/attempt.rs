//! One bind attempt: target resolution, worktree creation and probing.

use super::*;

/// A bind step's result: a value, or the failure the bind reports.
pub(super) type BindStep<T> = WorkspaceResult<Result<T, BindSessionWorktreeResult>>;

/// The facts a successful bind reports.
pub(super) struct Bound<'a> {
    pub(super) action: SessionWorktreeAction,
    pub(super) branch: &'a str,
    pub(super) dirty: bool,
    pub(super) source_dirty: bool,
    pub(super) idempotent: bool,
}

/// Whether the bound worktree already existed or this bind created it.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum TargetOrigin {
    Reused,
    Created,
}

/// The worktree a bind resolves to.
pub(super) struct Target {
    pub(super) path: String,
    pub(super) origin: TargetOrigin,
}

/// The git side of one bind request.
pub(super) struct BindAttempt<'a> {
    pub(super) git: GitWorktrees<'a>,
    pub(super) action: SessionWorktreeAction,
    pub(super) branch: &'a str,
    pub(super) abort: CancellationToken,
}

impl BindAttempt<'_> {
    pub(super) fn fail(&self, code: &'static str) -> BindSessionWorktreeResult {
        failure(self.action, Some(self.branch), code)
    }

    /// Selects the existing worktree of the branch, or creates (or reuses) the
    /// one at the prepared path.
    pub(super) async fn resolve_target(
        &self,
        anchor: &str,
        created_path: Option<String>,
        start_point: Option<String>,
    ) -> BindStep<Target> {
        let entries = match self.git.list(anchor, self.abort.clone()).await? {
            Ok(entries) => entries,
            Err(code) => return Ok(Err(self.fail(code.as_str()))),
        };
        let branch_entries: Vec<_> = entries
            .iter()
            .filter(|entry| entry.branch.as_deref() == Some(self.branch))
            .collect();
        if self.action == SessionWorktreeAction::Select {
            let Some(selected) = branch_entries.first() else {
                return Ok(Err(self.fail("linked_worktree_not_found")));
            };
            return Ok(Ok(Target {
                path: selected.path.to_string_lossy().into_owned(),
                origin: TargetOrigin::Reused,
            }));
        }
        let Some(target) = created_path else {
            return Ok(Err(self.fail("git_operation_failed")));
        };
        let mut target_entry = None;
        for entry in &entries {
            if self
                .git
                .same_path(&entry.path.to_string_lossy(), &target)
                .await?
            {
                target_entry = Some(entry);
                break;
            }
        }
        let target_on_branch =
            target_entry.is_some_and(|entry| entry.branch.as_deref() == Some(self.branch));
        if !branch_entries.is_empty() && !target_on_branch {
            return Ok(Err(self.fail("branch_already_checked_out")));
        }
        if target_on_branch {
            return Ok(Ok(Target {
                path: target,
                origin: TargetOrigin::Reused,
            }));
        }
        if target_entry.is_some() || self.git.occupied(&target).await? {
            return Ok(Err(self.fail("worktree_target_occupied")));
        }
        self.add_worktree(anchor, target, start_point).await
    }

    /// `git worktree add` for an existing local branch, or with `-b` from the
    /// start point (default `HEAD`).
    pub(super) async fn add_worktree(
        &self,
        anchor: &str,
        target: String,
        start_point: Option<String>,
    ) -> BindStep<Target> {
        let exists = self
            .git
            .local_branch_exists(anchor, self.branch, self.abort.clone())
            .await?;
        let args = if exists {
            vec![
                "worktree".into(),
                "add".into(),
                target.clone(),
                self.branch.into(),
            ]
        } else {
            vec![
                "worktree".into(),
                "add".into(),
                "-b".into(),
                self.branch.into(),
                target.clone(),
                start_point.unwrap_or_else(|| "HEAD".into()),
            ]
        };
        let created = self.git.run(anchor, args, self.abort.clone()).await?;
        if let Some(code) = git::command_failure(&created, WorkspaceCode::GitOperationFailed) {
            return self
                .cancel_or_fail(Some(&target), anchor, code.as_str())
                .await
                .map(Err);
        }
        Ok(Ok(Target {
            path: target,
            origin: TargetOrigin::Created,
        }))
    }

    /// Validates the worktree and reads whether the source checkout is dirty.
    pub(super) async fn inspect(
        &self,
        anchor: &str,
        target: &Target,
    ) -> BindStep<(Validated, bool)> {
        let validated = match self
            .git
            .validate(anchor, &target.path, self.branch, self.abort.clone())
            .await?
        {
            Ok(value) => value,
            Err(code) => return self.probe_failed(anchor, target, code).await.map(Err),
        };
        match self.git.dirty(anchor, self.abort.clone()).await? {
            Ok(source_dirty) => Ok(Ok((validated, source_dirty))),
            Err(code) => self.probe_failed(anchor, target, code).await.map(Err),
        }
    }

    /// A cancelled probe of a worktree this bind created may have left a
    /// partial creation behind; other probe failures report their code.
    pub(super) async fn probe_failed(
        &self,
        anchor: &str,
        target: &Target,
        code: WorkspaceCode,
    ) -> WorkspaceResult<BindSessionWorktreeResult> {
        if code == WorkspaceCode::Cancelled
            && target.origin == TargetOrigin::Created
            && self.action == SessionWorktreeAction::Create
        {
            return self
                .cancel_or_fail(Some(&target.path), anchor, code.as_str())
                .await;
        }
        Ok(self.fail(code.as_str()))
    }

    pub(super) async fn cancel_or_fail(
        &self,
        target: Option<&str>,
        anchor: &str,
        code: &'static str,
    ) -> WorkspaceResult<BindSessionWorktreeResult> {
        if (code == "cancelled" || code == "git_operation_failed")
            && let Some(target) = target
            && self
                .git
                .partial_creation(anchor, target, self.branch)
                .await?
        {
            return Ok(self.fail("partial_creation"));
        }
        Ok(self.fail(code))
    }
}
