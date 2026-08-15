import type {
  WorkspaceMutationError,
  WorkspaceMutationFailure,
} from "./workspace-file-mutation.ts";

export function isNodeFsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function workspaceMutationFailure(
  path: string,
  error: WorkspaceMutationError,
  details: Partial<Omit<WorkspaceMutationFailure, "ok" | "error" | "path">> = {},
): WorkspaceMutationFailure {
  const messages: Record<WorkspaceMutationError, string> = {
    invalid_arguments: "The file mutation arguments are invalid.",
    target_not_regular_file: "The target must be an existing regular file.",
    not_found: "The target file was not found.",
    file_exists: "The target file already exists and overwrite is false.",
    expected_sha256_required: "Replacing an existing file requires its current expected_sha256.",
    expected_sha256_mismatch: "The target file no longer matches expected_sha256.",
    expected_sha256_on_missing_file: "A missing target cannot be guarded with expected_sha256.",
    external_change_conflict: "The target changed after preflight and was not overwritten.",
    parent_directory_missing: "The target parent directory does not exist.",
    parent_directory_unwritable: "The target parent directory is not writable.",
    permission_denied: "The file mutation was denied by filesystem permissions.",
    io_error: "The filesystem could not complete the file mutation.",
  };
  const recoveryHints: Record<WorkspaceMutationError, string> = {
    invalid_arguments: "Retry with the canonical file mutation fields.",
    target_not_regular_file: "Choose an existing regular file.",
    not_found: "Check the workspace-relative path and retry.",
    file_exists: "Retry with overwrite=true and the current expected_sha256, or choose a new path.",
    expected_sha256_required: "Read the current file and retry with its complete SHA-256.",
    expected_sha256_mismatch: "Read the current file, review the change, and retry with its SHA-256.",
    expected_sha256_on_missing_file: "Retry creation without expected_sha256.",
    external_change_conflict: "Re-read the file, review the external change, and retry from the current SHA-256.",
    parent_directory_missing: "Create the parent explicitly with create_parents=true or choose an existing directory.",
    parent_directory_unwritable: "Choose a writable workspace directory or adjust its permissions.",
    permission_denied: "Choose a writable workspace path or adjust its permissions.",
    io_error: "Retry after checking the workspace filesystem and permissions.",
  };
  return {
    ok: false,
    error,
    path,
    message: messages[error],
    recovery_hint: recoveryHints[error],
    ...details,
  };
}

export function mapWorkspaceMutationReadFailure(
  path: string,
  error: unknown,
  missingError: WorkspaceMutationError = "not_found",
): WorkspaceMutationFailure {
  if (isNodeFsError(error)) {
    if (error.code === "ENOENT") return workspaceMutationFailure(path, missingError);
    if (error.code === "EACCES" || error.code === "EPERM") {
      return workspaceMutationFailure(path, "permission_denied");
    }
  }
  return workspaceMutationFailure(path, "io_error");
}
