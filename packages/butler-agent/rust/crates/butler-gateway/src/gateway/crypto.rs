//! Small keyed-hash primitives shared by the gateway's signed tokens:
//! HMAC-SHA256 (RFC 2104), constant-time comparison and random secrets.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

const BLOCK_SIZE: usize = 64;

/// HMAC-SHA256 of `payload` under `key`.
pub(crate) fn hmac_sha256(key: &[u8], payload: &[u8]) -> [u8; 32] {
    let mut block = [0_u8; BLOCK_SIZE];
    if key.len() > BLOCK_SIZE {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(block.map(|byte| byte ^ 0x36));
    inner.update(payload);
    let mut outer = Sha256::new();
    outer.update(block.map(|byte| byte ^ 0x5c));
    outer.update(inner.finalize());
    outer.finalize().into()
}

/// URL-safe base64 (no padding) HMAC-SHA256 of `payload` under `key`.
pub(crate) fn hmac_sha256_base64(key: &[u8], payload: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(hmac_sha256(key, payload))
}

/// Compares two secrets without an early exit on the first differing byte.
pub(crate) fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len() && bool::from(left.ct_eq(right))
}

/// 32 bytes from the operating system's random source (two v4 UUIDs, 244
/// random bits, condensed by SHA-256 so every output bit is uniform).
pub(crate) fn random_bytes() -> [u8; 32] {
    let mut digest = Sha256::new();
    digest.update(uuid::Uuid::new_v4().as_bytes());
    digest.update(uuid::Uuid::new_v4().as_bytes());
    digest.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        use std::fmt::Write;
        bytes.iter().fold(String::new(), |mut out, byte| {
            let _ = write!(out, "{byte:02x}");
            out
        })
    }

    /// RFC 4231 test cases 1, 2, 3 and 6 (short, text, repeated and
    /// longer-than-block keys).
    #[test]
    fn hmac_sha256_matches_rfc_4231_vectors() {
        let cases: [(&[u8], &[u8], &str); 4] = [
            (
                &[0x0b; 20],
                b"Hi There",
                "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
            ),
            (
                b"Jefe",
                b"what do ya want for nothing?",
                "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
            ),
            (
                &[0xaa; 20],
                &[0xdd; 50],
                "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe",
            ),
            (
                &[0xaa; 131],
                b"Test Using Larger Than Block-Size Key - Hash Key First",
                "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
            ),
        ];
        for (key, payload, expected) in cases {
            assert_eq!(hex(&hmac_sha256(key, payload)), expected);
        }
    }
}
