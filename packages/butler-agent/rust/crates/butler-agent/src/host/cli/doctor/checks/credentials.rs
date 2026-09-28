//! Saved API keys (#217): where they are kept, and whether any is still in
//! the credentials file as plain text (the agent moves those at its next
//! start). Reads the credentials file only, never a credential store.

use std::path::Path;

use serde_json::json;

use super::Check;
use butler_models::models::{SecretStoreMode, credential_file_summary};

pub(in crate::host::cli::doctor) fn credentials_check(data: &Path) -> Check {
    let file = credential_file_summary(data);
    let in_fallback = file.storage.contains_key("fallback_file");
    let (status, summary) = if !file.present {
        ("pass", "no API keys are saved")
    } else if file.legacy_plaintext > 0 {
        (
            "warn",
            "some saved API keys are still plain text; the agent moves them to the credential store when it starts",
        )
    } else if file.owner_only == Some(false) {
        ("warn", "the saved API keys file is readable by other users")
    } else if in_fallback {
        (
            "pass",
            "saved API keys are kept in the owner-only fallback file",
        )
    } else {
        (
            "pass",
            "saved API keys are kept in the system credential store",
        )
    };
    Check {
        id: "credentials",
        status,
        summary,
        evidence: json!({
            "present": file.present,
            "ownerOnly": file.owner_only,
            "storage": file.storage,
            "legacyPlaintext": file.legacy_plaintext,
            "requestedStore": SecretStoreMode::from_environment().as_str(),
        }),
    }
}
