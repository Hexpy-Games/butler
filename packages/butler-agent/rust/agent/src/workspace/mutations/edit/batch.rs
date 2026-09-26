use std::collections::HashMap;

use super::super::contracts::{BatchResult, CommitObserver, EditFailure, EditedFile, GuardedEdit};
use super::super::io::{self, Prepared, Snapshot};
use super::{decode, edit_failure, locator};

struct Target {
    path: String,
    first_index: usize,
    edit_indexes: Vec<usize>,
    start_line: usize,
    expected_sha256: Option<String>,
}

struct Ready {
    target: Target,
    prepared: Prepared,
}

pub(super) fn execute(edits: &[GuardedEdit], observer: &dyn CommitObserver) -> BatchResult {
    let mut outcome = BatchResult {
        applied: Vec::new(),
        unchanged: Vec::new(),
        preflight_failures: Vec::new(),
        conflicting: Vec::new(),
        not_attempted: Vec::new(),
        error: None,
    };
    let mut snapshots: HashMap<String, Snapshot> = HashMap::new();
    let mut texts: HashMap<String, String> = HashMap::new();
    for edit in edits {
        let key = &edit.path.public;
        if !snapshots.contains_key(key) {
            let path = super::super::contracts::GuardedPath {
                public: key.clone(),
                absolute: edit.path.absolute.clone(),
                real: edit.path.real.clone(),
            };
            let snapshot = match io::observe(path, false) {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    outcome
                        .preflight_failures
                        .push(edit_failure(edit.input.index, error));
                    continue;
                }
            };
            if !snapshot.exists {
                outcome.preflight_failures.push(EditFailure::new(
                    edit.input.index,
                    Some(key.clone()),
                    "not_found",
                ));
                continue;
            }
            let text = match decode(&snapshot.bytes) {
                Ok(text) => text.to_owned(),
                Err(error) => {
                    outcome.preflight_failures.push(EditFailure::new(
                        edit.input.index,
                        Some(key.clone()),
                        error,
                    ));
                    continue;
                }
            };
            texts.insert(key.clone(), text);
            snapshots.insert(key.clone(), snapshot);
        }
        let Some(snapshot) = snapshots.get(key) else {
            continue;
        };
        if let Err(error) =
            io::prepare_guard(snapshot, edit.input.expected_sha256.as_deref(), false)
        {
            outcome
                .preflight_failures
                .push(edit_failure(edit.input.index, error));
        }
    }
    if !outcome.preflight_failures.is_empty() {
        return preflight_failed(outcome, edits);
    }
    let mut targets = Vec::<Target>::new();
    let mut target_indices = HashMap::<String, usize>::new();
    for edit in edits {
        let key = &edit.path.public;
        let Some(text) = texts.get_mut(key) else {
            continue;
        };
        let location = match locator::locate(text, &edit.input.old_text, edit.input.start_line) {
            Ok(location) => location,
            Err(failure) => {
                let mut error =
                    EditFailure::new(edit.input.index, Some(key.clone()), failure.error);
                error.occurrences = Some(failure.occurrences);
                outcome.preflight_failures.push(error);
                return preflight_failed(outcome, edits);
            }
        };
        text.replace_range(
            location.offset..location.offset + edit.input.old_text.len(),
            &edit.input.new_text,
        );
        if let Some(position) = target_indices.get(key) {
            targets[*position].edit_indexes.push(edit.input.index);
        } else {
            target_indices.insert(key.clone(), targets.len());
            targets.push(Target {
                path: key.clone(),
                first_index: edit.input.index,
                edit_indexes: vec![edit.input.index],
                start_line: location.start_line,
                expected_sha256: edit.input.expected_sha256.clone(),
            });
        }
    }
    let mut ready = Vec::new();
    for target in targets {
        let (Some(snapshot), Some(after)) =
            (snapshots.remove(&target.path), texts.remove(&target.path))
        else {
            continue;
        };
        if snapshot.bytes == after.as_bytes() {
            outcome.unchanged.push((target.first_index, target.path));
            continue;
        }
        match io::prepare(
            snapshot,
            after.into_bytes(),
            target.expected_sha256.as_deref(),
            false,
        ) {
            Ok(prepared) => ready.push(Ready { target, prepared }),
            Err(error) => outcome
                .preflight_failures
                .push(edit_failure(target.first_index, error)),
        }
    }
    if !outcome.preflight_failures.is_empty() {
        return preflight_failed(outcome, edits);
    }
    let mut remaining = ready.into_iter();
    while let Some(ready_target) = remaining.next() {
        observer.before_target(
            ready_target.target.first_index,
            &ready_target.prepared.before.path.absolute,
        );
        match io::commit(ready_target.prepared, observer) {
            Ok(committed) => outcome.applied.push(EditedFile {
                index: ready_target.target.first_index,
                edit_indexes: ready_target.target.edit_indexes,
                start_line: ready_target.target.start_line,
                committed,
            }),
            Err(failure) => {
                let error = failure.error;
                outcome
                    .conflicting
                    .push(edit_failure(ready_target.target.first_index, failure));
                outcome.not_attempted = remaining
                    .map(|target| {
                        (
                            target.target.first_index,
                            Some(target.target.path),
                            target.target.edit_indexes,
                        )
                    })
                    .collect();
                outcome.error = Some(if outcome.applied.is_empty() {
                    error
                } else {
                    "partial_apply"
                });
                return outcome;
            }
        }
    }
    outcome
}

fn preflight_failed(mut outcome: BatchResult, edits: &[GuardedEdit]) -> BatchResult {
    outcome.error = Some("batch_preflight_failed");
    outcome.not_attempted = edits
        .iter()
        .map(|edit| (edit.input.index, Some(edit.safe_path.clone()), Vec::new()))
        .collect();
    outcome
}
