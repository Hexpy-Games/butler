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

/// Applies a batch of guarded edits all-or-nothing per preflight: every file
/// is snapshotted, guarded and edited in memory before any commit, and a
/// commit conflict leaves the remaining targets unattempted.
pub(super) fn execute(edits: &[GuardedEdit], observer: &dyn CommitObserver) -> BatchResult {
    let mut outcome = BatchResult {
        applied: Vec::new(),
        unchanged: Vec::new(),
        preflight_failures: Vec::new(),
        conflicting: Vec::new(),
        not_attempted: Vec::new(),
        error: None,
    };
    let mut files = snapshot_files(edits, &mut outcome.preflight_failures);
    if !outcome.preflight_failures.is_empty() {
        return preflight_failed(outcome, edits);
    }
    let targets = match apply_in_memory(edits, &mut files.texts) {
        Ok(targets) => targets,
        Err(failure) => {
            outcome.preflight_failures.push(failure);
            return preflight_failed(outcome, edits);
        }
    };
    let ready = prepare_targets(targets, &mut files, &mut outcome);
    if !outcome.preflight_failures.is_empty() {
        return preflight_failed(outcome, edits);
    }
    commit_targets(ready, observer, outcome)
}

/// The snapshot and decoded text of every edited file, keyed by public path.
struct Files {
    snapshots: HashMap<String, Snapshot>,
    texts: HashMap<String, String>,
}

/// Snapshots and decodes each file once and checks every edit's expected
/// digest; failures are collected for all edits.
fn snapshot_files(edits: &[GuardedEdit], failures: &mut Vec<EditFailure>) -> Files {
    let mut files = Files {
        snapshots: HashMap::new(),
        texts: HashMap::new(),
    };
    for edit in edits {
        let key = &edit.path.public;
        if !files.snapshots.contains_key(key) {
            match snapshot_file(edit) {
                Ok((snapshot, text)) => {
                    files.texts.insert(key.clone(), text);
                    files.snapshots.insert(key.clone(), snapshot);
                }
                Err(failure) => {
                    failures.push(failure);
                    continue;
                }
            }
        }
        let Some(snapshot) = files.snapshots.get(key) else {
            continue;
        };
        if let Err(error) = io::prepare_guard(
            snapshot,
            edit.input.expected_sha256.as_deref(),
            io::Replacement::Unguarded,
        ) {
            failures.push(edit_failure(edit.input.index, error));
        }
    }
    files
}

fn snapshot_file(edit: &GuardedEdit) -> Result<(Snapshot, String), EditFailure> {
    let key = &edit.path.public;
    let path = super::super::contracts::GuardedPath {
        public: key.clone(),
        absolute: edit.path.absolute.clone(),
        real: edit.path.real.clone(),
    };
    let snapshot = io::observe(path, io::Parent::MustExist)
        .map_err(|error| edit_failure(edit.input.index, error))?;
    if !snapshot.exists {
        return Err(EditFailure::new(
            edit.input.index,
            Some(key.clone()),
            "not_found",
        ));
    }
    let text = decode(&snapshot.bytes)
        .map_err(|error| EditFailure::new(edit.input.index, Some(key.clone()), error.code()))?
        .to_owned();
    Ok((snapshot, text))
}

/// Applies the edits to the decoded texts in order and groups them by file;
/// the first edit whose old text cannot be located fails the batch.
fn apply_in_memory(
    edits: &[GuardedEdit],
    texts: &mut HashMap<String, String>,
) -> Result<Vec<Target>, EditFailure> {
    let mut targets = Vec::<Target>::new();
    let mut target_indices = HashMap::<String, usize>::new();
    for edit in edits {
        let key = &edit.path.public;
        let Some(text) = texts.get_mut(key) else {
            continue;
        };
        let location = locator::locate(text, &edit.input.old_text, edit.input.start_line).map_err(
            |failure| {
                let mut error =
                    EditFailure::new(edit.input.index, Some(key.clone()), failure.error);
                error.occurrences = Some(failure.occurrences);
                error
            },
        )?;
        text.replace_range(
            location.offset..location.offset + edit.input.old_text.len(),
            &edit.input.new_text,
        );
        if let Some(target) = target_indices
            .get(key)
            .and_then(|position| targets.get_mut(*position))
        {
            target.edit_indexes.push(edit.input.index);
            continue;
        }
        target_indices.insert(key.clone(), targets.len());
        targets.push(Target {
            path: key.clone(),
            first_index: edit.input.index,
            edit_indexes: vec![edit.input.index],
            start_line: location.start_line,
            expected_sha256: edit.input.expected_sha256.clone(),
        });
    }
    Ok(targets)
}

/// Prepares the commit of every changed file; files whose text did not
/// change are reported unchanged.
fn prepare_targets(
    targets: Vec<Target>,
    files: &mut Files,
    outcome: &mut BatchResult,
) -> Vec<Ready> {
    let mut ready = Vec::new();
    for target in targets {
        let (Some(snapshot), Some(after)) = (
            files.snapshots.remove(&target.path),
            files.texts.remove(&target.path),
        ) else {
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
            io::Replacement::Unguarded,
        ) {
            Ok(prepared) => ready.push(Ready { target, prepared }),
            Err(error) => outcome
                .preflight_failures
                .push(edit_failure(target.first_index, error)),
        }
    }
    ready
}

/// Commits the prepared files in order; the first conflict stops the batch.
fn commit_targets(
    ready: Vec<Ready>,
    observer: &dyn CommitObserver,
    mut outcome: BatchResult,
) -> BatchResult {
    let mut remaining = ready.into_iter();
    while let Some(Ready { target, prepared }) = remaining.next() {
        observer.before_target(target.first_index, &prepared.before.path.absolute);
        let failure = match io::commit(prepared, observer) {
            Ok(committed) => {
                outcome.applied.push(EditedFile {
                    index: target.first_index,
                    edit_indexes: target.edit_indexes,
                    start_line: target.start_line,
                    committed,
                });
                continue;
            }
            Err(failure) => failure,
        };
        let error = failure.error;
        outcome
            .conflicting
            .push(edit_failure(target.first_index, failure));
        outcome.not_attempted = remaining
            .map(|ready| {
                (
                    ready.target.first_index,
                    Some(ready.target.path),
                    ready.target.edit_indexes,
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
