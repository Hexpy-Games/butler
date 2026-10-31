//! Every encryption goes through age. Nothing here derives or combines keys.

use super::VaultError;
use age::secrecy::SecretString;
use age::{DecryptError, Decryptor, Encryptor, Identity, Recipient, scrypt, x25519};
use butler_platform::secrets::SecretText;
use std::io::{Read, Write};
use std::iter;
use zeroize::Zeroizing;

/// The shortest new password, in characters: a password-protected file can be
/// attacked offline, slowed only by scrypt.
pub const MIN_PASSWORD_CHARS: usize = 12;

/// How many different characters a new password needs, so that length alone
/// cannot be met by repeating a few.
pub const MIN_PASSWORD_DISTINCT_CHARS: usize = 6;

/// How far into a file age's header must end. age's header parser is quadratic
/// in its length (64 KiB takes seconds in a release build) and runs while the
/// change lock is held, so a small file could otherwise hang the process. This
/// allows well over a hundred recipients.
const MAX_HEADER_BYTES: usize = 16 * 1024;

/// scrypt `N = 2^18` (256 MiB), the age reference CLI's work factor. Fixed
/// rather than timed on this machine, so a file written on a fast computer
/// still opens quickly on a slow one.
const PASSWORD_WORK_FACTOR: u8 = 18;

/// The largest scrypt work factor accepted when opening (1 GiB), so a file the
/// user picked cannot demand tens of gigabytes.
const MAX_WORK_FACTOR: u8 = 20;

pub(super) fn check_new_password(password: &SecretText) -> Result<(), VaultError> {
    // A fixed array: this holds the password's characters and is never reallocated.
    let mut distinct = Zeroizing::new(['\0'; MIN_PASSWORD_DISTINCT_CHARS]);
    let (mut count, mut found) = (0, 0);
    for character in password.expose().chars() {
        count += 1;
        if found < MIN_PASSWORD_DISTINCT_CHARS && !distinct[..found].contains(&character) {
            distinct[found] = character;
            found += 1;
        }
    }
    if count < MIN_PASSWORD_CHARS || found < MIN_PASSWORD_DISTINCT_CHARS {
        return Err(VaultError::WeakPassword);
    }
    Ok(())
}

/// Encrypts to every recipient; age refuses an empty list.
pub(super) fn seal_to(recipients: &[String], plaintext: &[u8]) -> Result<Vec<u8>, VaultError> {
    let parsed = recipients
        .iter()
        .map(|text| text.parse::<x25519::Recipient>())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| VaultError::InvalidRecipient)?;
    let encryptor = Encryptor::with_recipients(parsed.iter().map(|r| r as &dyn Recipient))
        .map_err(|_| VaultError::InvalidRecipient)?;
    seal(encryptor, plaintext)
}

pub(super) fn seal_with_password(
    password: &SecretText,
    plaintext: &[u8],
) -> Result<Vec<u8>, VaultError> {
    let mut recipient = scrypt::Recipient::new(secret_string(password));
    recipient.set_work_factor(PASSWORD_WORK_FACTOR);
    let encryptor = Encryptor::with_recipients(iter::once(&recipient as &dyn Recipient))
        .map_err(|_| VaultError::InvalidRecipient)?;
    seal(encryptor, plaintext)
}

fn seal(encryptor: Encryptor, plaintext: &[u8]) -> Result<Vec<u8>, VaultError> {
    let mut sealed = Vec::with_capacity(plaintext.len() + 512);
    let mut writer = encryptor.wrap_output(&mut sealed).map_err(VaultError::Io)?;
    writer.write_all(plaintext).map_err(VaultError::Io)?;
    writer.finish().map_err(VaultError::Io)?;
    Ok(sealed)
}

/// Opens a file for `identity`. Any changed byte, or another key, is
/// [`VaultError::Refused`].
pub(super) fn open_with(
    identity: &x25519::Identity,
    sealed: &[u8],
) -> Result<Zeroizing<Vec<u8>>, VaultError> {
    let reader = decryptor(sealed)?
        .decrypt(iter::once(identity as &dyn Identity))
        .map_err(|_| VaultError::Refused)?;
    read_all(reader, sealed.len())
}

/// Opens a password-protected file. A file for recipients, or one with changed
/// bytes past the password check, is [`VaultError::Refused`]. age's password
/// stanza cannot tell a wrong password from a changed stanza, so either is
/// [`VaultError::WrongPassword`].
pub(super) fn open_with_password(
    password: &SecretText,
    sealed: &[u8],
) -> Result<Zeroizing<Vec<u8>>, VaultError> {
    let decryptor = decryptor(sealed)?;
    if !decryptor.is_scrypt() {
        return Err(VaultError::Refused);
    }
    let mut identity = scrypt::Identity::new(secret_string(password));
    identity.set_max_work_factor(MAX_WORK_FACTOR);
    let reader = decryptor
        .decrypt(iter::once(&identity as &dyn Identity))
        .map_err(|error| match error {
            DecryptError::DecryptionFailed => VaultError::WrongPassword,
            _ => VaultError::Refused,
        })?;
    read_all(reader, sealed.len())
}

/// Parses a file's header, refusing first one that does not end early.
fn decryptor(sealed: &[u8]) -> Result<Decryptor<&[u8]>, VaultError> {
    let start = sealed.get(..MAX_HEADER_BYTES).unwrap_or(sealed);
    if !start.windows(5).any(|part| part == b"\n--- ") {
        return Err(VaultError::Refused);
    }
    Decryptor::new_buffered(sealed).map_err(|_| VaultError::Refused)
}

/// Plaintext is shorter than its file, so `capacity` never needs to grow, which
/// would leave an unwiped copy behind.
fn read_all(mut reader: impl Read, capacity: usize) -> Result<Zeroizing<Vec<u8>>, VaultError> {
    let mut plaintext = Zeroizing::new(Vec::with_capacity(capacity));
    reader
        .read_to_end(&mut plaintext)
        .map_err(|_| VaultError::Refused)?;
    Ok(plaintext)
}

fn secret_string(password: &SecretText) -> SecretString {
    SecretString::from(password.expose().to_owned())
}
