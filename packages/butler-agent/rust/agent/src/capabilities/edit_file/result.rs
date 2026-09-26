use std::time::Duration;

use serde_json::{Value, json};

use super::super::mutation_evidence;
use crate::workspace::{BatchResult, ChangedFile, EditFailure, EditedFile, MutationOutcome};

pub(in crate::capabilities) fn changed_file_value(detail: &ChangedFile) -> Value {
    let mut value = json!({
        "path":detail.path,"additions":detail.additions,"deletions":detail.deletions,
        "lines":detail.lines.iter().map(|line| {
            let mut value = json!({"type":line.kind,"content":line.content});
            if let Some(number) = line.old_line { value["old_line"] = json!(number); }
            if let Some(number) = line.new_line { value["new_line"] = json!(number); }
            value
        }).collect::<Vec<_>>(),
        "before_text":detail.before_text,"after_text":detail.after_text,
    });
    if detail.file_created {
        value["file_created"] = json!(true);
    }
    value
}

pub(super) fn project(outcome: MutationOutcome, elapsed: Duration) -> Value {
    match outcome {
        MutationOutcome::Batch(result) => batch_result(&result, elapsed),
        MutationOutcome::Single(result) => single_result(result, elapsed),
        MutationOutcome::Write(_) => super::failure(
            "workspace_mutation_outcome_mismatch",
            "The workspace returned a write outcome for an edit.",
            "Retry the edit.",
        ),
    }
}

fn single_result(result: Result<EditedFile, EditFailure>, elapsed: Duration) -> Value {
    match result {
        Ok(file) => {
            let committed = &file.committed;
            let reference = json!({"path":committed.path,"start_line":file.start_line,
                "replacements":1,"before_sha256":committed.before_sha256,
                "after_sha256":committed.after_sha256,"atomic_write":true});
            let mut value = json!({"ok":true,"path":committed.path,
                "start_line":file.start_line,"replacements":1,"bytes":committed.bytes,
                "before_sha256":committed.before_sha256,"after_sha256":committed.after_sha256,
                "atomic_write":true,
                "metrics":{"elapsed_ms":elapsed.as_millis() as u64,
                    "files_written":1,"bytes_written":committed.bytes},
                "evidence_receipts":mutation_evidence::execution("edit_file",
                    &format!("Edited workspace file {}", committed.path),&reference),
                "evidence_capability_receipts":mutation_evidence::success("edit_file",
                    Some(&committed.path),&[],&[],mutation_evidence::MutationOperation::Edited,committed.bytes)});
            if committed.cleanup_failed {
                value["cleanup_failed"] = json!(true);
            }
            if let Some(detail) = &committed.changed_file {
                value["changed_file"] = changed_file_value(detail);
            }
            value
        }
        Err(failure) => {
            let (message, hint) = if failure.guard.is_some() {
                (
                    "The requested workspace path was rejected.",
                    "Retry with a regular workspace-relative file path.",
                )
            } else {
                (failure_message(failure.error), failure_hint(failure.error))
            };
            let mut value = super::failure(failure.error, message, hint);
            if let Some(path) = &failure.path {
                value["path"] = json!(path);
            }
            if let Some(before) = &failure.before_sha256 {
                value["before_sha256"] = json!(before);
            }
            if let Some(current) = &failure.current_sha256 {
                value["current_sha256"] = json!(current);
            }
            if let Some(expected) = &failure.expected_sha256 {
                value["expected_sha256"] = json!(expected);
            }
            if let Some(start_line) = failure.start_line {
                value["start_line"] = json!(start_line);
            }
            if let Some(bytes) = failure.bytes {
                value["bytes"] = json!(bytes);
            }
            if let Some(occurrences) = failure.occurrences {
                value["occurrences"] = json!(occurrences);
            }
            if let Some(guard) = &failure.guard {
                value["guard"] = guard.public_rejection();
            }
            value
        }
    }
}

fn batch_result(result: &BatchResult, elapsed: Duration) -> Value {
    let applied: Vec<Value> = result.applied.iter().map(applied_record).collect();
    let unchanged: Vec<Value> = result
        .unchanged
        .iter()
        .map(|(index, path)| json!({"index":index,"path":path,"changed":false}))
        .collect();
    let paths: Vec<String> = result
        .applied
        .iter()
        .map(|file| file.committed.path.clone())
        .collect();
    let bytes = result
        .applied
        .iter()
        .map(|file| file.committed.bytes)
        .sum::<usize>();
    if let Some(error) = result.error {
        let failures: Vec<Value> = result
            .preflight_failures
            .iter()
            .map(failure_record)
            .collect();
        let conflicting: Vec<Value> = result.conflicting.iter().map(failure_record).collect();
        let not_attempted: Vec<Value> = result
            .not_attempted
            .iter()
            .map(|(index, path, indexes)| {
                let mut value = json!({"index":index});
                if let Some(path) = path {
                    value["path"] = json!(path);
                }
                if !indexes.is_empty() {
                    value["edit_indexes"] = json!(indexes);
                }
                value
            })
            .collect();
        let (message,hint) = match error {
            "batch_preflight_failed" => (
                "No files were changed because at least one batch edit failed preflight.".to_owned(),
                "Resolve every listed file error and retry the complete batch."),
            "external_change_conflict" => (
                "The batch was not applied because its first target changed after preflight.".to_owned(),
                "Re-read the conflicting file and retry the complete batch from current SHA-256 values."),
            "partial_apply" => (
                "The batch stopped after a file changed or failed; committed files were not rolled back.".to_owned(),
                "Review applied and conflicting files, then re-read and retry only the remaining intended edits."),
            _ => (
                format!("The batch was not applied because the first commit failed with {error}."),
                "Resolve the conflicting file error before retrying the intended edits."),
        };
        let receipt_paths =
            if error == "batch_preflight_failed" {
                let mut unique = Vec::new();
                for (_, path, _) in &result.not_attempted {
                    if let Some(path) = path
                        && !unique.contains(path)
                    {
                        unique.push(path.clone());
                    }
                }
                unique
            } else {
                let mut indexed: Vec<_> = result
                    .applied
                    .iter()
                    .map(|file| (file.index, file.committed.path.clone()))
                    .collect();
                indexed.extend(
                    result.conflicting.iter().filter_map(|file| {
                        file.path.as_ref().map(|path| (file.index, path.clone()))
                    }),
                );
                indexed.extend(result.not_attempted.iter().filter_map(|(index, path, _)| {
                    path.as_ref().map(|path| (*index, path.clone()))
                }));
                indexed.sort_by_key(|(index, _)| *index);
                indexed.into_iter().map(|(_, path)| path).collect()
            };
        let (receipt_applied, receipt_conflicting, receipt_not_attempted) =
            if error == "batch_preflight_failed" {
                (&[][..], &[][..], &[][..])
            } else {
                (&applied[..], &conflicting[..], &not_attempted[..])
            };
        let mut value = json!({"ok":false,"error":error,"message":message,
            "recovery_hint":hint,"applied":applied,"conflicting":conflicting,
            "not_attempted":not_attempted,
            "evidence_capability_receipts":mutation_evidence::failure("edit_file",error,
                &receipt_paths,receipt_applied,receipt_conflicting,receipt_not_attempted)});
        if error == "batch_preflight_failed" {
            value["preflight_failures"] = json!(failures);
        }
        return value;
    }
    let changed_files: Vec<Value> = result
        .applied
        .iter()
        .filter_map(|file| file.committed.changed_file.as_ref().map(changed_file_value))
        .collect();
    json!({"ok":true,"changed":!applied.is_empty(),"unchanged":unchanged,
        "files":applied,"applied":applied,"changed_files":changed_files,
        "metrics":{"elapsed_ms":elapsed.as_millis() as u64,
            "files_written":result.applied.len(),"bytes_written":bytes},
        "evidence_receipts":if applied.is_empty(){Vec::new()}else{
            mutation_evidence::execution("edit_file",
                &format!("Edited {} workspace files",applied.len()),
                &json!({"batch":true,"applied":applied}))},
        "evidence_capability_receipts":mutation_evidence::success("edit_file",
            None,&paths,&applied,mutation_evidence::MutationOperation::Batch { edited: !applied.is_empty() },bytes)})
}

fn applied_record(file: &EditedFile) -> Value {
    let committed = &file.committed;
    let mut value = json!({"index":file.index,"edit_indexes":file.edit_indexes,
        "path":committed.path,"bytes":committed.bytes,"start_line":file.start_line,
        "before_sha256":committed.before_sha256,"after_sha256":committed.after_sha256});
    if committed.cleanup_failed {
        value["cleanup_failed"] = json!(true);
    }
    if let Some(detail) = &committed.changed_file {
        value["changed_file"] = changed_file_value(detail);
    }
    value
}

fn failure_record(failure: &EditFailure) -> Value {
    let mut value = json!({"index":failure.index,"error":failure.error});
    if let Some(path) = &failure.path {
        value["path"] = json!(path);
    }
    if let Some(occurrences) = failure.occurrences {
        value["occurrences"] = json!(occurrences);
    }
    if let Some(before) = &failure.before_sha256 {
        value["before_sha256"] = json!(before);
    }
    if let Some(current) = &failure.current_sha256 {
        value["current_sha256"] = json!(current);
    }
    if let Some(guard) = &failure.guard {
        value["guard"] = guard.public_rejection();
    }
    value
}

fn failure_message(error: &str) -> &str {
    match error {
        "binary_file_not_supported" => "Binary files cannot be edited with exact text edits.",
        "invalid_utf8" => "The file is not valid UTF-8.",
        "old_text_ambiguous" => "old_text occurs more than once in the target file.",
        "old_text_mismatch" => "old_text was not found in the target file.",
        "target_not_regular_file" => "The target must be an existing regular file.",
        "not_found" => "The target file was not found.",
        "file_exists" => "The target file already exists and overwrite is false.",
        "expected_sha256_required" => {
            "Replacing an existing file requires its current expected_sha256."
        }
        "expected_sha256_mismatch" => "The target file no longer matches expected_sha256.",
        "expected_sha256_on_missing_file" => {
            "A missing target cannot be guarded with expected_sha256."
        }
        "external_change_conflict" => "The target changed after preflight and was not overwritten.",
        "parent_directory_missing" => "The target parent directory does not exist.",
        "parent_directory_unwritable" => "The target parent directory is not writable.",
        "permission_denied" => "The file mutation was denied by filesystem permissions.",
        "io_error" => "The filesystem could not complete the file mutation.",
        _ => "The file mutation could not be completed.",
    }
}

fn failure_hint(error: &str) -> &str {
    match error {
        "binary_file_not_supported" | "invalid_utf8" => {
            "Choose a UTF-8 text file or use a purpose-built binary workflow."
        }
        "old_text_ambiguous" | "old_text_mismatch" => {
            "Retry with exact text and, when needed, a correct start_line hint."
        }
        "target_not_regular_file" => "Choose an existing regular file.",
        "not_found" => "Check the workspace-relative path and retry.",
        "file_exists" => {
            "Retry with overwrite=true and the current expected_sha256, or choose a new path."
        }
        "expected_sha256_required" => "Read the current file and retry with its complete SHA-256.",
        "expected_sha256_mismatch" => {
            "Read the current file, review the change, and retry with its SHA-256."
        }
        "expected_sha256_on_missing_file" => "Retry creation without expected_sha256.",
        "external_change_conflict" => {
            "Re-read the file, review the external change, and retry from the current SHA-256."
        }
        "parent_directory_missing" => {
            "Create the parent explicitly with create_parents=true or choose an existing directory."
        }
        "parent_directory_unwritable" => {
            "Choose a writable workspace directory or adjust its permissions."
        }
        "permission_denied" => "Choose a writable workspace path or adjust its permissions.",
        _ => "Retry after checking the workspace filesystem and permissions.",
    }
}
