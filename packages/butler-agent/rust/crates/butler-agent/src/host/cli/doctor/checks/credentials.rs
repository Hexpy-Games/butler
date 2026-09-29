//! Saved API keys (#217): which store new keys go to and why (an unsigned
//! build keeps them in the owner-only file; a Developer ID signed build or
//! `secrets.store` picks the system store), whether any key is still plain
//! text in the credentials file (the agent moves those at its next start),
//! and whether removals are still pending. Reads files only, never a
//! credential store.

use std::path::Path;

use serde_json::json;

use super::Check;
use butler_models::models::{SecretStoreFacts, credential_file_summary, credential_store_policy};

pub(in crate::host::cli::doctor) fn credentials_check(data: &Path) -> Check {
    let file = credential_file_summary(data);
    let policy = credential_store_policy(data, SecretStoreFacts::for_data_root(data));
    let (status, summary) = if file.legacy_plaintext > 0 {
        (
            "warn",
            "some saved API keys are still plain text; the agent moves them when it starts",
        )
    } else if file.present && file.owner_only == Some(false) {
        ("warn", "the saved API keys file is readable by other users")
    } else if policy.override_ignored {
        (
            "warn",
            "BUTLER_SECRET_STORE=file is ignored for the default data folder",
        )
    } else if file.pending_removals > 0 {
        (
            "warn",
            "some deleted API keys are still in a credential store; the agent retries when it starts",
        )
    } else if policy.store == "system" {
        ("pass", "new API keys go to the system credential store")
    } else if butler_platform::secure_fs::OWNER_ONLY || file.owner_only == Some(true) {
        (
            "pass",
            "new API keys go to the owner-only file in the data folder",
        )
    } else {
        (
            "warn",
            "new API keys go to a file in the data folder that this host does not restrict to its owner",
        )
    };
    Check {
        id: "credentials",
        status,
        summary,
        evidence: json!({
            "store": policy.store,
            "systemBackend": policy.system_backend,
            "reason": policy.reason,
            "overrideIgnored": policy.override_ignored,
            "present": file.present,
            "ownerOnly": file.owner_only,
            "storage": file.storage,
            "legacyPlaintext": file.legacy_plaintext,
            "pendingRemovals": file.pending_removals,
        }),
    }
}
