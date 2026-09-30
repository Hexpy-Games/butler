//! Public classification of App storage failures; underlying causes stay private.

use super::{AppStorageError, GatewayApplicationError, public};

pub(super) fn app_error(error: AppStorageError) -> GatewayApplicationError {
    if error.is_busy() {
        return public(503, "storage_busy", "Storage is busy. Try again.").with_source(error);
    }
    if error.is_stopping() {
        return public(503, "service_stopping", "Service is stopping. Try again.")
            .with_source(error);
    }
    match error.code() {
        "automation_interval_invalid"
        | "project_required"
        | "message_file_not_found"
        | "too_many_attachments"
        | "empty_queued_message"
        | "invalid_message_content" => public(400, error.code(), &error.detail()),
        "automation_not_enabled"
        | "automation_state_invalid"
        | "message_file_already_attached"
        | "queued_message_changed"
        | "general_channel_protected"
        | "queued_message_identity_conflict"
        | "project_source_scope_changed"
        | "session_relocating"
        | "session_model_unavailable"
        | "authority_queue_immutable"
        | "queued_message_cas_conflict"
        | "turn_not_cancellable" => public(409, error.code(), &error.detail()),
        "message_file_wrong_session" => public(403, error.code(), &error.detail()),
        "session_not_found"
        | "automation_not_found"
        | "project_not_found"
        | "queued_message_not_found"
        | "turn_not_found" => public(404, error.code(), &error.detail()),
        "turn_control_resolution_invalid" => public(500, error.code(), &error.detail()),
        _ => GatewayApplicationError::internal_from(error),
    }
}
