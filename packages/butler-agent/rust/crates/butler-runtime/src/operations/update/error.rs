//! Failures of App and Agent update checks, staging and application.

use std::error::Error;

wire_codes! {
    /// Wire codes of update failures.
    pub enum UpdateCode {
        AgentVersionUnavailable = "agent_version_unavailable",
        AppVersionUnavailable = "app_version_unavailable",
        ButlerDataOverlapsInstallation = "butler_data_overlaps_installation",
        InstallArchiveFormatUnsupported = "install_archive_format_unsupported",
        InstallArchiveTooLarge = "install_archive_too_large",
        InstallArchiveUnsafe = "install_archive_unsafe",
        InstallBusy = "install_busy",
        InstallHomeUnavailable = "install_home_unavailable",
        InstallManifestInvalid = "install_manifest_invalid",
        InstallNothingToRollBack = "install_nothing_to_roll_back",
        InstallPlatformMismatch = "install_platform_mismatch",
        InstallSha256Required = "install_sha256_required",
        InstallSwitchFailed = "install_switch_failed",
        InstallVerificationFailed = "install_verification_failed",
        InstallVersionAmbiguous = "install_version_ambiguous",
        InstallVersionNotFound = "install_version_not_found",
        InstallWriteFailed = "install_write_failed",
        UnsupportedComponent = "unsupported_component",
        UpdateArtifactNameInvalid = "update_artifact_name_invalid",
        UpdateArtifactSha256Mismatch = "update_artifact_sha256_mismatch",
        UpdateArtifactSha256Missing = "update_artifact_sha256_missing",
        UpdateArtifactSourceInvalid = "update_artifact_source_invalid",
        UpdateArtifactUnavailable = "update_artifact_unavailable",
        UpdateArtifactUrlMissing = "update_artifact_url_missing",
        UpdateCancelled = "update_cancelled",
        UpdateHttpUnavailable = "update_http_unavailable",
        UpdateManifestAgentPlatformMissing = "update_manifest_agent_platform_missing",
        UpdateManifestAppPlatformMissing = "update_manifest_app_platform_missing",
        UpdateManifestArtifactsMissing = "update_manifest_artifacts_missing",
        UpdateManifestComponentInvalid = "update_manifest_component_invalid",
        UpdateManifestIncompatible = "update_manifest_incompatible",
        UpdateManifestInvalid = "update_manifest_invalid",
        UpdateManifestSha256Invalid = "update_manifest_sha256_invalid",
        UpdateManifestSourceInvalid = "update_manifest_source_invalid",
        UpdateManifestTooLarge = "update_manifest_too_large",
        UpdateManifestUnavailable = "update_manifest_unavailable",
        UpdateManifestVersionMissing = "update_manifest_version_missing",
        UpdateSignatureUnsupported = "update_signature_unsupported",
        UpdateStagePathInvalid = "update_stage_path_invalid",
        UpdateStageUnavailable = "update_stage_unavailable",
        UpdateStatusInvalid = "update_status_invalid",
    }
}

/// A failed update check, stage or apply. `Display` is the wire code, as the
/// CLI and App have always reported it; the source keeps the underlying
/// HTTP, filesystem or JSON error.
#[derive(Debug, thiserror::Error)]
#[error("{code}")]
pub struct UpdateError {
    code: UpdateCode,
    #[source]
    source: Option<Box<dyn Error + Send + Sync>>,
}

impl UpdateError {
    /// An update failure caused by `source`.
    pub(crate) fn caused(
        code: UpdateCode,
        source: impl Into<Box<dyn Error + Send + Sync>>,
    ) -> Self {
        Self {
            code,
            source: Some(source.into()),
        }
    }

    pub fn code(&self) -> &'static str {
        self.code.as_str()
    }
}

impl From<UpdateCode> for UpdateError {
    fn from(code: UpdateCode) -> Self {
        Self { code, source: None }
    }
}

#[cfg(test)]
mod tests {
    use super::UpdateCode;
    use crate::context::ContextCode;
    use crate::operations::automation::AutomationCode;
    use crate::web_access::WebAccessCode;

    fn spelled<T: Copy>(all: &[T], as_str: fn(T) -> &'static str) -> Vec<&'static str> {
        all.iter().map(|code| as_str(*code)).collect()
    }

    /// Format pin: every wire code table of the runtime (context, automation,
    /// update and web access) keeps its pinned spelling and order.
    // test-category: format-pin
    #[test]
    fn wire_codes_are_stable() {
        for (domain, codes, pinned) in [
            (
                "update",
                spelled(UpdateCode::ALL, UpdateCode::as_str),
                include_str!("wire_codes.txt"),
            ),
            (
                "automation",
                spelled(AutomationCode::ALL, AutomationCode::as_str),
                include_str!("../automation/wire_codes.txt"),
            ),
            (
                "context",
                spelled(ContextCode::ALL, ContextCode::as_str),
                include_str!("../../context/wire_codes.txt"),
            ),
            (
                "web access",
                spelled(WebAccessCode::ALL, WebAccessCode::as_str),
                include_str!("../../web_access/wire_codes.txt"),
            ),
        ] {
            let expected: Vec<&str> = pinned.lines().collect();
            assert_eq!(codes, expected, "{domain}");
        }
    }
}
