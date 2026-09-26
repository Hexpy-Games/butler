use super::super::path_guard::GuardResult;
use super::contracts::{MutationFailure, MutationFailureData};

pub(super) fn new(path: Option<String>, error: &'static str) -> MutationFailure {
    let (message, recovery_hint) = match error {
        "target_not_regular_file" => (
            "The target must be an existing regular file.",
            "Choose an existing regular file.",
        ),
        "not_found" => (
            "The target file was not found.",
            "Check the workspace-relative path and retry.",
        ),
        "file_exists" => (
            "The target file already exists and overwrite is false.",
            "Retry with overwrite=true and the current expected_sha256, or choose a new path.",
        ),
        "expected_sha256_required" => (
            "Replacing an existing file requires its current expected_sha256.",
            "Read the current file and retry with its complete SHA-256.",
        ),
        "expected_sha256_mismatch" => (
            "The target file no longer matches expected_sha256.",
            "Read the current file, review the change, and retry with its SHA-256.",
        ),
        "expected_sha256_on_missing_file" => (
            "A missing target cannot be guarded with expected_sha256.",
            "Retry creation without expected_sha256.",
        ),
        "external_change_conflict" => (
            "The target changed after preflight and was not overwritten.",
            "Re-read the file, review the external change, and retry from the current SHA-256.",
        ),
        "parent_directory_missing" => (
            "The target parent directory does not exist.",
            "Create the parent explicitly with create_parents=true or choose an existing directory.",
        ),
        "parent_directory_unwritable" => (
            "The target parent directory is not writable.",
            "Choose a writable workspace directory or adjust its permissions.",
        ),
        "permission_denied" => (
            "The file mutation was denied by filesystem permissions.",
            "Choose a writable workspace path or adjust its permissions.",
        ),
        "tool_not_admitted" => (
            "The file mutation is not admitted for this Steward task.",
            "Use only the exact mutation capability in the delegated packet.",
        ),
        "invalid_arguments" => (
            "The file mutation arguments are invalid.",
            "Retry with the canonical file mutation fields.",
        ),
        _ => (
            "The filesystem could not complete the file mutation.",
            "Retry after checking the workspace filesystem and permissions.",
        ),
    };
    MutationFailure::from_data(MutationFailureData {
        path,
        error,
        message: message.into(),
        recovery_hint: recovery_hint.into(),
        before_sha256: None,
        expected_sha256: None,
        current_sha256: None,
        guard: None,
    })
}

pub(super) fn guard(guard: GuardResult) -> MutationFailure {
    let mut failure = new(guard.safe_path(), guard.reason.unwrap_or("path_rejected"));
    failure.message = "The requested workspace path was rejected.".into();
    failure.recovery_hint = "Retry with a regular workspace-relative file path.".into();
    failure.guard = Some(Box::new(guard));
    failure
}

pub(super) fn io(path: Option<String>, error: &std::io::Error) -> MutationFailure {
    let kind = match error.kind() {
        std::io::ErrorKind::NotFound => "not_found",
        std::io::ErrorKind::PermissionDenied => "permission_denied",
        _ => "io_error",
    };
    new(path, kind)
}
