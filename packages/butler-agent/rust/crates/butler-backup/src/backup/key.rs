use ring::{
    aead, hkdf, hmac,
    rand::{SecureRandom, SystemRandom},
};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::backup::BackupError;

const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

pub struct BackupKey(Zeroizing<[u8; 28]>);

pub struct Subkeys {
    pub id: hmac::Key,
    pub enc: aead::LessSafeKey,
    pub vault_secret: Zeroizing<[u8; 32]>,
}

struct KeyLength;
impl hkdf::KeyType for KeyLength {
    fn len(&self) -> usize {
        32
    }
}

impl BackupKey {
    #[expect(clippy::expect_used, reason = "generation requires OS randomness")]
    pub fn generate() -> Self {
        let mut key = Zeroizing::new([0; 28]);
        SystemRandom::new()
            .fill(&mut *key)
            .expect("system randomness unavailable");
        Self(key)
    }

    pub fn recovery_text(&self) -> Zeroizing<String> {
        let mut bytes = Zeroizing::new([0; 30]);
        bytes[..28].copy_from_slice(&*self.0);
        bytes[28..].copy_from_slice(&Sha256::digest(self.0.as_slice())[..2]);
        let mut text = Zeroizing::new(String::with_capacity(48));
        for group in bytes.as_chunks::<5>().0 {
            let bits = group
                .iter()
                .fold(0u64, |bits, &byte| (bits << 8) | u64::from(byte));
            for shift in (0..8).rev() {
                text.push(char::from(
                    ALPHABET[usize::try_from((bits >> (shift * 5)) & 31).unwrap_or_default()],
                ));
            }
        }
        text
    }

    #[expect(
        clippy::expect_used,
        reason = "HKDF and AEAD accept these fixed lengths"
    )]
    pub fn subkeys(&self) -> Subkeys {
        let salt = hkdf::Salt::new(hkdf::HKDF_SHA256, b"butler-backup-v1");
        let prk = salt.extract(&*self.0);
        let derive = |label: &[u8]| {
            let mut bytes = Zeroizing::new([0; 32]);
            prk.expand(&[label], KeyLength)
                .expect("fixed HKDF length")
                .fill(&mut *bytes)
                .expect("fixed HKDF output");
            bytes
        };
        Subkeys {
            id: hmac::Key::new(hmac::HMAC_SHA256, &*derive(b"chunk-id")),
            enc: aead::LessSafeKey::new(
                aead::UnboundKey::new(&aead::CHACHA20_POLY1305, &*derive(b"chunk-key"))
                    .expect("fixed AEAD key length"),
            ),
            vault_secret: derive(b"vault-recovery"),
        }
    }
}

pub fn parse_recovery(text: &str) -> Result<BackupKey, BackupError> {
    let mut bytes = Zeroizing::new([0; 30]);
    let mut count = 0;
    for byte in text.bytes().filter(|byte| !matches!(byte, b' ' | b'-')) {
        let byte = match byte.to_ascii_uppercase() {
            b'O' => b'0',
            b'I' | b'L' => b'1',
            byte => byte,
        };
        let digit = ALPHABET
            .iter()
            .position(|&entry| entry == byte)
            .filter(|_| count < 240)
            .ok_or(BackupError::RecoveryKeyInvalid)?;
        for shift in (0..5).rev() {
            bytes[count / 8] |= u8::from((digit >> shift) & 1 != 0) << (7 - count % 8);
            count += 1;
        }
    }
    if count != 240 || Sha256::digest(&bytes[..28])[..2] != bytes[28..] {
        return Err(BackupError::RecoveryKeyInvalid);
    }
    let mut key = Zeroizing::new([0; 28]);
    key.copy_from_slice(&bytes[..28]);
    Ok(BackupKey(key))
}
