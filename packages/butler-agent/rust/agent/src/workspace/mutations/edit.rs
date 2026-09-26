mod batch;
mod locator;

pub(crate) fn prepare_exact_text(
    text: &str,
    old_text: &str,
    new_text: &str,
    start_line: Option<usize>,
) -> Result<(String, usize), &'static str> {
    let location = locator::locate(text, old_text, start_line).map_err(|error| error.error)?;
    let mut after = text.to_owned();
    after.replace_range(location.offset..location.offset + old_text.len(), new_text);
    Ok((after, location.start_line))
}

use super::contracts::{
    EditFailure, EditFailureData, EditMutation, EditedFile, GuardedEdit, MutationOutcome,
};
use super::io;

pub(super) fn execute(input: EditMutation, paths: Vec<GuardedEdit>) -> MutationOutcome {
    if input.batch {
        MutationOutcome::Batch(batch::execute(input, paths))
    } else {
        MutationOutcome::Single(single(
            paths.into_iter().next().expect("single guarded edit"),
        ))
    }
}

fn single(edit: GuardedEdit) -> Result<EditedFile, EditFailure> {
    let path = edit.path.public.clone();
    let snapshot = io::observe(edit.path, false).map_err(|error| edit_failure(0, error))?;
    if !snapshot.exists {
        return Err(EditFailure::new(0, Some(path), "not_found"));
    }
    let text = decode(&snapshot.bytes).map_err(|error| {
        let mut failure = EditFailure::new(0, Some(path.clone()), error);
        failure.bytes = Some(snapshot.bytes.len());
        failure
    })?;
    io::prepare_guard(&snapshot, edit.input.expected_sha256.as_deref(), false)
        .map_err(|error| edit_failure(0, error))?;
    let location =
        locator::locate(text, &edit.input.old_text, edit.input.start_line).map_err(|failure| {
            EditFailure::from_data(EditFailureData {
                index: 0,
                path: Some(path.clone()),
                error: failure.error,
                occurrences: Some(failure.occurrences),
                before_sha256: snapshot.sha256.clone(),
                current_sha256: None,
                expected_sha256: None,
                start_line: edit.input.start_line,
                bytes: None,
                guard: None,
            })
        })?;
    let mut after = text.to_owned();
    after.replace_range(
        location.offset..location.offset + edit.input.old_text.len(),
        &edit.input.new_text,
    );
    let prepared = io::prepare(
        snapshot,
        after.into_bytes(),
        edit.input.expected_sha256.as_deref(),
        false,
    )
    .map_err(|error| edit_failure(0, error))?;
    let committed = io::commit(prepared).map_err(|error| edit_failure(0, error))?;
    Ok(EditedFile {
        index: 0,
        edit_indexes: vec![0],
        start_line: location.start_line,
        committed,
    })
}

pub(super) fn decode(bytes: &[u8]) -> Result<&str, &'static str> {
    if bytes.iter().take(4096).any(|byte| *byte == 0) {
        return Err("binary_file_not_supported");
    }
    std::str::from_utf8(bytes).map_err(|_| "invalid_utf8")
}

pub(super) fn edit_failure(
    index: usize,
    failure: super::contracts::MutationFailure,
) -> EditFailure {
    let failure = failure.into_data();
    EditFailure::from_data(EditFailureData {
        index,
        path: failure.path,
        error: failure.error,
        occurrences: None,
        before_sha256: failure.before_sha256,
        current_sha256: failure.current_sha256,
        expected_sha256: failure.expected_sha256,
        start_line: None,
        bytes: None,
        guard: failure.guard,
    })
}
