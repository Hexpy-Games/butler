//! macOS: generic passwords in the user's login Keychain. An item's access
//! list trusts the program that created it by its code signature; a program
//! signed differently (an ad-hoc signed update, say) is asked for by the
//! system before it can read the item. Hence [`developer_id_signed`]: only a
//! Developer ID signature stays the same across updates.

use std::sync::Arc;

use security_framework::os::macos::code_signing::{Flags, SecCode, SecRequirement};

use super::{SecretBackend, SecretError};

pub(super) const BACKEND: SecretBackend = SecretBackend::Keychain;

/// Apple's code requirement for a Developer ID Application signature: the
/// Developer ID intermediate certificate and the Developer ID Application
/// leaf certificate, anchored at Apple.
const DEVELOPER_ID: &str = "anchor apple generic \
    and certificate 1[field.1.2.840.113635.100.6.2.6] exists \
    and certificate leaf[field.1.2.840.113635.100.6.1.13] exists";

pub(super) fn open() -> Result<Arc<keyring_core::CredentialStore>, SecretError> {
    let store: Arc<keyring_core::CredentialStore> =
        apple_native_keyring_store::keychain::Store::new().map_err(SecretError::Unavailable)?;
    Ok(store)
}

/// Whether the running code satisfies [`DEVELOPER_ID`]; any failure (ad-hoc
/// or no signature, a requirement that does not parse) is false.
pub(super) fn developer_id_signed() -> bool {
    let Ok(requirement) = DEVELOPER_ID.parse::<SecRequirement>() else {
        return false;
    };
    SecCode::for_self(Flags::NONE)
        .and_then(|code| code.check_validity(Flags::NONE, &requirement))
        .is_ok()
}
