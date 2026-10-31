//! Why a vault operation failed. No variant carries secret bytes, and none
//! keeps a parser's message, which could quote the text it failed on.

use butler_platform::secrets::SecretError;
use std::io;

#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    /// No key is in memory. Unlock first.
    #[error("the vault is locked")]
    Locked,
    /// There is no vault file here, and no previous copy either.
    #[error("there is no vault here")]
    Absent,
    /// Creating would replace a vault, or the copy kept from its last save.
    #[error("a vault already exists here")]
    AlreadyExists,
    /// The file changed, is damaged, or is not for this key. It is left as is.
    #[error("the vault file refused to open")]
    Refused,
    /// The file opened but holds a format this build does not know, so saving
    /// would lose data. It is left as is.
    #[error("the vault file has an unknown format")]
    Format,
    /// This unlock path holds no key.
    #[error("no key is stored for this unlock path")]
    NoKey,
    #[error("the password is wrong")]
    WrongPassword,
    /// A new password is shorter than [`super::MIN_PASSWORD_CHARS`], or has fewer
    /// than [`super::MIN_PASSWORD_DISTINCT_CHARS`] different characters.
    #[error("the password is too weak")]
    WeakPassword,
    /// The store is not an OS credential store. The key would otherwise sit
    /// unwrapped in a file beside the ciphertext.
    #[error("the vault key needs the system credential store")]
    NotSystemStore,
    /// The change would leave no way to open the vault.
    #[error("this would remove the last way to unlock the vault")]
    LastUnlockPath,
    #[error("the recipient is not a valid public key")]
    InvalidRecipient,
    /// No copy from an earlier save exists, or it does not open either.
    #[error("no usable previous copy exists")]
    NoPrevious,
    /// Restoring is only for a vault that refuses to open.
    #[error("the vault file opens normally")]
    NotDamaged,
    /// An export holds times too far ahead of this clock. Merging would let
    /// them beat every later local change.
    #[error("the file has times too far in the future")]
    TimeAhead,
    /// An export would sit among the vault's own files, or replace one.
    #[error("an export cannot go in the vault's folder")]
    ExportInsideVault,
    #[error("the credential store failed")]
    Store(#[source] SecretError),
    #[error("the vault file could not be read or written")]
    Io(#[source] io::Error),
}

/// A missing file as `missing`, any other failure as [`VaultError::Io`].
pub(super) fn io_or(missing: VaultError) -> impl FnOnce(io::Error) -> VaultError {
    move |error| {
        if error.kind() == io::ErrorKind::NotFound {
            missing
        } else {
            VaultError::Io(error)
        }
    }
}
