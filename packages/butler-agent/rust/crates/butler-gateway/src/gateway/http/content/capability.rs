use crate::gateway::crypto::{constant_time_eq, hmac_sha256, hmac_sha256_base64};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};

fn key(token: &str) -> [u8; 32] {
    hmac_sha256(token.as_bytes(), b"butler-output-capability-v1")
}
pub(super) fn sign(token: &str, id: &str, revision: u64, now: u64) -> String {
    let payload = URL_SAFE_NO_PAD.encode(format!("{id}:{revision}:{}", now + 3600));
    format!(
        "{payload}.{}",
        hmac_sha256_base64(&key(token), payload.as_bytes())
    )
}
pub(super) fn verify(token: &str, cap: &str, now: u64) -> Option<(String, u64)> {
    let (payload, mac) = cap.split_once('.')?;
    if !constant_time_eq(
        mac.as_bytes(),
        hmac_sha256_base64(&key(token), payload.as_bytes()).as_bytes(),
    ) {
        return None;
    }
    let decoded = String::from_utf8(URL_SAFE_NO_PAD.decode(payload).ok()?).ok()?;
    let mut parts = decoded.split(':');
    let id = parts.next()?.to_owned();
    let revision = parts.next()?.parse().ok()?;
    let expires: u64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() || expires <= now || expires > now + 3600 {
        return None;
    }
    Some((id, revision))
}
