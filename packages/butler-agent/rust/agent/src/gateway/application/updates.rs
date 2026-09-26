use super::GatewayApplicationError;

pub(super) fn update_error(code: String) -> GatewayApplicationError {
    let (status, message) = match code.as_str() {
        "unsupported_component" => (400, "Only Butler App package updates are available."),
        "app_version_unavailable" => (503, "Installed Butler App version is unavailable."),
        "update_manifest_incompatible" | "update_signature_unsupported" => (
            422,
            "Update manifest is incompatible with the native App updater.",
        ),
        "update_manifest_unavailable" | "update_artifact_unavailable" => {
            (503, "Update source is unavailable.")
        }
        "update_artifact_sha256_mismatch" => (422, "Update package checksum did not match."),
        "update_cancelled" => (503, "Update request was cancelled."),
        code if code.starts_with("update_manifest_") => (422, "Update manifest is invalid."),
        code if code.starts_with("update_artifact_") => (422, "Update package is invalid."),
        _ => (500, "Update staging is unavailable."),
    };
    GatewayApplicationError::Public {
        status,
        code,
        message: message.into(),
    }
}
