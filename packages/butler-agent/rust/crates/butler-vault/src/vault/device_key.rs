//! This device's age identity: the only key that opens `vault.age`.

use super::VaultError;
use super::cipher;
use age::secrecy::ExposeSecret;
use age::x25519;
use butler_platform::secrets::SecretText;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

/// age's identity wipes its secret when dropped.
pub(super) struct DeviceKey {
    identity: x25519::Identity,
    recipient: String,
}

impl DeviceKey {
    pub(super) fn generate() -> Self {
        Self::from_identity(x25519::Identity::generate())
    }

    fn from_identity(identity: x25519::Identity) -> Self {
        let recipient = identity.to_public().to_string();
        Self {
            identity,
            recipient,
        }
    }

    /// An identity read from an unlock path. Text that is not an identity is
    /// [`VaultError::Refused`].
    pub(super) fn parse(text: &str) -> Result<Self, VaultError> {
        text.trim()
            .parse::<x25519::Identity>()
            .map(Self::from_identity)
            .map_err(|_| VaultError::Refused)
    }

    /// The identity's text, as an age identity file holds it.
    pub(super) fn text(&self) -> SecretText {
        SecretText::new(self.identity.to_string().expose_secret().to_owned())
    }

    pub(super) fn identity(&self) -> &x25519::Identity {
        &self.identity
    }

    /// The public key. Whoever holds it can write a valid vault file, so it
    /// stays inside the encrypted payload.
    pub(super) fn recipient(&self) -> &str {
        &self.recipient
    }

    /// A stable id for this device, for merge ties. It shows nothing outside
    /// the encrypted payload.
    pub(super) fn device_id(&self) -> String {
        let digest = format!("{:x}", Sha256::digest(self.recipient.as_bytes()));
        digest.get(..16).unwrap_or(&digest).to_owned()
    }

    pub(super) fn same_as(&self, other: &Self) -> bool {
        self.recipient == other.recipient
    }

    /// This identity as a file only `password` opens: what `age -p` makes from
    /// an identity file, so the standard CLI can read it too.
    pub(super) fn wrap(&self, password: &SecretText) -> Result<Vec<u8>, VaultError> {
        let text = self.text();
        // Sized up front: growing would leave an unwiped copy behind.
        let mut line = Zeroizing::new(String::with_capacity(text.expose().len() + 1));
        line.push_str(text.expose());
        line.push('\n');
        cipher::seal_with_password(password, line.as_bytes())
    }

    pub(super) fn unwrap(password: &SecretText, wrapped: &[u8]) -> Result<Self, VaultError> {
        let plaintext = cipher::open_with_password(password, wrapped)?;
        let text = std::str::from_utf8(&plaintext).map_err(|_| VaultError::Refused)?;
        Self::parse(text)
    }
}
