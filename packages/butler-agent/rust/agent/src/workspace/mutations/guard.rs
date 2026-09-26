use std::collections::HashMap;
use std::path::PathBuf;

use super::super::path_guard::{MutationGuardInput, resolve_workspace_mutation_guard};
use super::contracts::{
    BatchResult, EditFailure, EditFailureData, EditMutation, GuardedCommand, GuardedEdit,
    GuardedPath, MutationCommand, MutationContext, MutationOutcome,
};
use super::failure;

pub(super) fn prepare(
    command: MutationCommand,
) -> std::io::Result<Result<GuardedCommand, MutationOutcome>> {
    match command {
        MutationCommand::Write(write) => {
            let guarded = path(&write.context, &write.path, true)?;
            Ok(match guarded {
                Ok(path) => Ok(GuardedCommand::Write(write, path)),
                Err(guard) => Err(MutationOutcome::Write(Err(failure::guard(guard)))),
            })
        }
        MutationCommand::Edit(mut edit) if !edit.batch => {
            let guarded = path(&edit.context, &edit.edits[0].path, false)?;
            Ok(match guarded {
                Ok(path) => {
                    let input = edit.edits.remove(0);
                    let safe_path = path.public.clone();
                    Ok(GuardedCommand::Edit(
                        edit,
                        vec![GuardedEdit {
                            input,
                            path,
                            safe_path,
                        }],
                    ))
                }
                Err(guard) => Err(MutationOutcome::Single(Err(EditFailure::from_data(
                    EditFailureData {
                        index: 0,
                        path: guard.safe_path(),
                        error: guard.reason.unwrap_or("path_rejected"),
                        occurrences: None,
                        before_sha256: None,
                        current_sha256: None,
                        expected_sha256: None,
                        start_line: None,
                        bytes: None,
                        guard: Some(Box::new(guard)),
                    },
                )))),
            })
        }
        MutationCommand::Edit(edit) => batch(edit),
    }
}

fn batch(mut edit: EditMutation) -> std::io::Result<Result<GuardedCommand, MutationOutcome>> {
    let mut guarded = Vec::with_capacity(edit.edits.len());
    let mut failures = Vec::new();
    let mut safe = Vec::with_capacity(edit.edits.len());
    let mut targets: HashMap<PathBuf, String> = HashMap::new();
    let requested = std::mem::take(&mut edit.edits);
    for item in requested {
        match path(&edit.context, &item.path, false)? {
            Ok(mut path) => {
                let safe_path = path.public.clone();
                let key = target_key(&path.real);
                path.public = targets.entry(key).or_insert(path.public).clone();
                safe.push(Some(safe_path.clone()));
                guarded.push(GuardedEdit {
                    input: item,
                    path,
                    safe_path,
                });
            }
            Err(guard) => {
                let public = guard.safe_path();
                safe.push(public.clone());
                failures.push(EditFailure::from_data(EditFailureData {
                    index: item.index,
                    path: public,
                    error: guard.reason.unwrap_or("path_rejected"),
                    occurrences: None,
                    before_sha256: None,
                    current_sha256: None,
                    expected_sha256: None,
                    start_line: None,
                    bytes: None,
                    guard: Some(Box::new(guard)),
                }));
            }
        }
    }
    if !failures.is_empty() {
        return Ok(Err(MutationOutcome::Batch(BatchResult {
            applied: Vec::new(),
            unchanged: Vec::new(),
            preflight_failures: failures,
            conflicting: Vec::new(),
            not_attempted: safe
                .into_iter()
                .enumerate()
                .map(|(index, path)| (index, path, Vec::new()))
                .collect(),
            error: Some("batch_preflight_failed"),
        })));
    }
    Ok(Ok(GuardedCommand::Edit(edit, guarded)))
}

fn path(
    context: &MutationContext,
    requested: &str,
    allow_missing_leaf: bool,
) -> std::io::Result<Result<GuardedPath, super::super::path_guard::GuardResult>> {
    let guard = resolve_workspace_mutation_guard(MutationGuardInput {
        root: &context.root,
        requested,
        relative_only: context.relative_only,
        allow_missing_leaf,
        installation_root: context.installation_root.as_deref(),
        protected_roots: &context.protected_roots,
    })?;
    if !guard.ok() {
        return Ok(Err(guard));
    }
    let absolute = guard.absolute.as_ref().expect("accepted path").clone();
    let real = guard.real.as_ref().unwrap_or(&absolute).clone();
    let public = absolute
        .strip_prefix(&guard.root)
        .expect("accepted containment")
        .to_string_lossy()
        .replace('\\', "/");
    Ok(Ok(GuardedPath {
        public: if public.is_empty() {
            ".".into()
        } else {
            public
        },
        absolute,
        real,
    }))
}

fn target_key(path: &std::path::Path) -> PathBuf {
    #[cfg(windows)]
    {
        PathBuf::from(path.to_string_lossy().replace('\\', "/").to_lowercase())
    }
    #[cfg(not(windows))]
    {
        path.to_path_buf()
    }
}
