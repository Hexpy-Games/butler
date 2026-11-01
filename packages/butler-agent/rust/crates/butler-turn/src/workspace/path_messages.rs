//! Accurate model-facing explanations for path guard failures.
use super::path_guard::GuardResult;
use serde_json::{Value, json};

pub(super) fn io_reason(error: &std::io::Error) -> &'static str {
    match error.to_string().as_str() {
        "sensitive_path_blocked" => return "sensitive_path_blocked",
        "contained_read_refused" => return "safety_refused",
        "path_escape" => return "path_escape",
        "symlink_escape" => return "symlink_escape",
        "protected_path" => return "protected_path",
        "parent_traversal_not_allowed" => return "parent_traversal_not_allowed",
        "absolute_path_not_allowed" => return "absolute_path_not_allowed",
        "directory_not_allowed" => return "directory_not_allowed",
        "not_a_file" => return "not_a_file",
        "special_file_not_allowed" => return "special_file_not_allowed",
        "missing_path" => return "missing_path",
        _ => {}
    }
    match error.kind() {
        std::io::ErrorKind::NotFound => "not_found",
        std::io::ErrorKind::PermissionDenied => "permission_denied",
        std::io::ErrorKind::NotADirectory => "not_a_directory",
        std::io::ErrorKind::InvalidInput => "invalid_path",
        _ => "io_error",
    }
}

/// What a file tool says about Butler's own credential stores, and what to do instead.
pub(super) const CREDENTIAL_STORE: (&str, &str) = (
    "Butler's own credential stores can't be changed with file tools.",
    "Ask the user to change this in Settings, or to edit the file themselves.",
);

pub(super) fn explanation(reason: &str) -> (&'static str, &'static str) {
    match reason {
        "safety_refused" => (
            "This file was refused for safety.",
            "Choose an ordinary file inside the workspace, outside credential stores.",
        ),
        "not_a_file" => (
            "The path is not a regular file.",
            "Choose an existing regular file.",
        ),
        "not_found" => (
            "The requested path was not found.",
            "Check the path or choose an existing file or directory.",
        ),
        "directory_not_allowed" => (
            "The requested path is a directory.",
            "Choose a regular file.",
        ),
        "not_a_directory" => (
            "The requested path is not a directory.",
            "Choose an existing directory.",
        ),
        "permission_denied" => (
            "Permission to access the requested path was denied.",
            "Choose a path the OS account can access.",
        ),
        "sensitive_path_blocked" => (
            "The requested path contains sensitive or credential files.",
            "Choose a non-sensitive path.",
        ),
        "credential_store_blocked" => CREDENTIAL_STORE,
        "program_directory_read_only" => (
            "Butler's program folder is read-only.",
            "Choose a path outside Butler's installation.",
        ),
        "protected_path" => (
            "Project Ledger paths require dedicated tools.",
            "Use Project Ledger tools.",
        ),
        "path_escape" | "symlink_escape" | "parent_escape" => (
            "The requested path is outside the permitted scope.",
            "Use a path inside the session workspace root.",
        ),
        "absolute_path_not_allowed" | "parent_traversal_not_allowed" => (
            "This operation requires a workspace-relative path without parent traversal.",
            "Use a workspace-relative path without parent traversal.",
        ),
        "special_file_not_allowed" => (
            "The requested path is a special file.",
            "Choose a regular file or directory.",
        ),
        "invalid_path" => (
            "The requested path is invalid.",
            "Use an unambiguous file or directory path.",
        ),
        "missing_path" => ("No path was provided.", "Provide a file or directory path."),
        _ => (
            "The requested path could not be accessed.",
            "Check the path and OS account permissions.",
        ),
    }
}

pub(super) fn read_rejection(guard: &GuardResult, requested: &str) -> Value {
    let path = if guard.path_form.contained() {
        guard.safe_path().unwrap_or_else(|| ".".into())
    } else {
        requested.into()
    };
    let reason = guard.reason.unwrap_or("path_rejected");
    let (message, hint) = explanation(reason);
    let code = if reason == "directory_not_allowed" {
        "not_a_file"
    } else {
        reason
    };
    let mut result = json!({"ok":false,"path":path,"error":code,
        "message":message,"recovery_hint":hint,"guard":guard.public_rejection()});
    if guard.path_form.contained()
        && let Some(fields) = result.as_object_mut()
    {
        fields.insert("workspace_root".into(), json!(guard.root));
    }
    result
}
