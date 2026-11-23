use crate::backup::{BackupError, key::Subkeys};
use ring::{
    aead, hmac,
    rand::{SecureRandom, SystemRandom},
};

const HEADER: &[u8] = b"BKP1";
const MANIFEST: &[u8] = b"butler-backup-v1:manifest";
const CHUNK: &str = "butler-backup-v1:chunk:";

#[expect(clippy::expect_used, reason = "writing to a String is infallible")]
pub fn chunk_id(keys: &Subkeys, plaintext: &[u8]) -> String {
    use std::fmt::Write;
    let mut id = String::with_capacity(64);
    for byte in hmac::sign(&keys.id, plaintext).as_ref() {
        write!(id, "{byte:02x}").expect("writing to String");
    }
    id
}

pub fn seal_chunk(keys: &Subkeys, id: &str, plaintext: &[u8]) -> Vec<u8> {
    seal(keys, format!("{CHUNK}{id}").as_bytes(), plaintext)
}

pub fn open_chunk(keys: &Subkeys, id: &str, sealed: Vec<u8>) -> Result<Vec<u8>, BackupError> {
    let plaintext =
        open(keys, format!("{CHUNK}{id}").as_bytes(), sealed).ok_or(BackupError::ChunkCorrupt)?;
    if chunk_id(keys, &plaintext) != id {
        return Err(BackupError::ChunkCorrupt);
    }
    Ok(plaintext)
}

pub fn seal_manifest(keys: &Subkeys, plaintext: &[u8]) -> Vec<u8> {
    seal(keys, MANIFEST, plaintext)
}

pub fn open_manifest(keys: &Subkeys, sealed: Vec<u8>) -> Result<Vec<u8>, BackupError> {
    open(keys, MANIFEST, sealed).ok_or(BackupError::RecoveryKeyWrong)
}

#[expect(
    clippy::expect_used,
    reason = "sealing bounded input requires OS randomness"
)]
fn seal(keys: &Subkeys, aad: &[u8], plaintext: &[u8]) -> Vec<u8> {
    let mut nonce = [0; 12];
    SystemRandom::new()
        .fill(&mut nonce)
        .expect("system randomness unavailable");
    let mut sealed = Vec::with_capacity(16 + plaintext.len() + 16);
    sealed.extend_from_slice(HEADER);
    sealed.extend_from_slice(&nonce);
    sealed.extend_from_slice(plaintext);
    let tag = keys
        .enc
        .seal_in_place_separate_tag(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(aad),
            &mut sealed[16..],
        )
        .expect("bounded backup plaintext");
    sealed.extend_from_slice(tag.as_ref());
    sealed
}

fn open(keys: &Subkeys, aad: &[u8], mut sealed: Vec<u8>) -> Option<Vec<u8>> {
    if !sealed.starts_with(HEADER) {
        return None;
    }
    let nonce = aead::Nonce::try_assume_unique_for_key(sealed.get(4..16)?).ok()?;
    let len = keys
        .enc
        .open_within(nonce, aead::Aad::from(aad), &mut sealed, 16..)
        .ok()?
        .len();
    sealed.truncate(len);
    Some(sealed)
}
