//! Zero-friction local browser access: `butler open` asks for a one-time
//! connection code (`POST /connection-codes`, bearer token only) and opens
//! `/connect?code=<code>`, which trades the code for an HttpOnly,
//! SameSite=Strict session cookie. The cookie is signed with the gateway
//! signing key, so it survives an agent restart and dies with the token.

use std::collections::HashMap;
use std::time::{Duration, SystemTime};

use axum::http::{HeaderMap, HeaderValue, header};
use parking_lot::Mutex;
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::{SigningKey, unix_seconds};
use crate::gateway::crypto::random_bytes;

/// How long a connection code can be redeemed.
const CODE_TTL: Duration = Duration::from_secs(300);
/// How long a browser session lasts.
const SESSION_TTL_SECONDS: u64 = 30 * 24 * 60 * 60;
/// Unredeemed codes kept at once; the oldest is dropped past this.
const MAX_PENDING_CODES: usize = 32;
/// Crockford base32: no I, L, O or U to misread when typed.
const CODE_ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_GROUPS: usize = 4;
const CODE_GROUP_LENGTH: usize = 4;
const SESSION_VERSION: &str = "v1";

/// A minted one-time link, as `POST /connection-codes` returns it.
#[derive(Debug, Serialize)]
pub(in crate::gateway::http) struct ConnectionLink {
    /// `http://<host>/connect?code=<code>`: opens the browser session.
    pub(in crate::gateway::http) url: String,
    /// The code alone, for the connection page (`XXXX-XXXX-XXXX-XXXX`).
    pub(in crate::gateway::http) code: String,
    /// When the code stops working (ISO 8601).
    pub(in crate::gateway::http) expires_at: String,
}

/// Pending one-time codes and the session cookie of one gateway listener.
pub(in crate::gateway::http) struct BrowserSessions {
    key: SigningKey,
    cookie_name: String,
    pending: Mutex<HashMap<[u8; 32], SystemTime>>,
}

impl BrowserSessions {
    /// The cookie name carries the port, so two gateways on one host keep
    /// their own sessions. Browsers still send it to every port of the host,
    /// which is why only the Butler page may use it (`fetch_metadata`).
    pub(in crate::gateway::http) fn new(key: SigningKey, port: u16) -> Self {
        Self {
            key,
            cookie_name: format!("butler_session_{port}"),
            pending: Mutex::new(HashMap::new()),
        }
    }

    /// Mints a one-time code whose link points at `authority` (a Host the
    /// policy already accepted).
    pub(in crate::gateway::http) fn mint(
        &self,
        authority: &str,
        now: SystemTime,
    ) -> ConnectionLink {
        let code = new_code();
        let expires = now + CODE_TTL;
        {
            let mut pending = self.pending.lock();
            pending.retain(|_, expiry| *expiry > now);
            while pending.len() >= MAX_PENDING_CODES {
                let oldest = pending
                    .iter()
                    .min_by_key(|(_, expiry)| **expiry)
                    .map(|(digest, _)| *digest);
                let Some(oldest) = oldest else { break };
                pending.remove(&oldest);
            }
            pending.insert(code_digest(&code), expires);
        }
        ConnectionLink {
            url: format!("http://{authority}/connect?code={code}"),
            expires_at: butler_core::js_date::iso_from_system_time(expires),
            code,
        }
    }

    /// Redeems `code` once; the `Set-Cookie` value for a new session.
    pub(in crate::gateway::http) fn redeem(
        &self,
        code: &str,
        now: SystemTime,
    ) -> Option<HeaderValue> {
        let expiry = self.pending.lock().remove(&code_digest(code))?;
        if expiry <= now {
            return None;
        }
        self.issue(now)
    }

    /// The `Set-Cookie` value for a new session (a redeemed code, or the
    /// session that rotated the connection code and needs the new key).
    pub(in crate::gateway::http) fn issue(&self, now: SystemTime) -> Option<HeaderValue> {
        let expires = unix_seconds(now).saturating_add(SESSION_TTL_SECONDS);
        let nonce = base64_url(&random_bytes()[..16]);
        let signature = self.key.mac(&session_message(expires, &nonce));
        let cookie = format!(
            "{}={SESSION_VERSION}.{expires}.{nonce}.{signature}; Path=/; HttpOnly; SameSite=Strict; Max-Age={SESSION_TTL_SECONDS}",
            self.cookie_name
        );
        HeaderValue::from_str(&cookie).ok()
    }

    /// Whether the request carries a valid, unexpired session cookie.
    pub(in crate::gateway::http) fn has_session(
        &self,
        headers: &HeaderMap,
        now: SystemTime,
    ) -> bool {
        headers
            .get_all(header::COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .flat_map(|value| value.split(';'))
            .filter_map(|pair| pair.trim().split_once('='))
            .filter(|(name, _)| *name == self.cookie_name)
            .any(|(_, value)| self.session_valid(value, unix_seconds(now)))
    }

    fn session_valid(&self, value: &str, now: u64) -> bool {
        let mut parts = value.split('.');
        let (Some(SESSION_VERSION), Some(expires), Some(nonce), Some(signature), None) = (
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
        ) else {
            return false;
        };
        expires.parse::<u64>().is_ok_and(|expires| {
            expires > now && self.key.verify(&session_message(expires, nonce), signature)
        })
    }
}

fn session_message(expires: u64, nonce: &str) -> String {
    format!("butler.browser-session.v1\n{expires}\n{nonce}")
}

/// `XXXX-XXXX-XXXX-XXXX`: 80 random bits, typeable.
fn new_code() -> String {
    let bytes = random_bytes();
    let mut code = String::with_capacity(CODE_GROUPS * (CODE_GROUP_LENGTH + 1));
    for index in 0..CODE_GROUPS * CODE_GROUP_LENGTH {
        if index > 0 && index % CODE_GROUP_LENGTH == 0 {
            code.push('-');
        }
        code.push(char::from(CODE_ALPHABET[usize::from(bytes[index] & 0x1f)]));
    }
    code
}

/// Codes are compared by digest of their canonical form: case, dashes and
/// spaces as typed do not matter.
fn code_digest(code: &str) -> [u8; 32] {
    let canonical: String = code
        .chars()
        .filter(|character| !matches!(character, '-' | ' '))
        .map(|character| character.to_ascii_uppercase())
        .collect();
    Sha256::digest(canonical.as_bytes()).into()
}

fn base64_url(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sessions() -> BrowserSessions {
        BrowserSessions::new(SigningKey::derive("token-for-session-tests"), 18765)
    }

    fn cookie_header(set_cookie: &HeaderValue) -> HeaderMap {
        let pair = set_cookie
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_str(&format!("other=1; {pair}")).unwrap(),
        );
        headers
    }

    /// Security boundary: a code works once, before it expires, for the
    /// session it mints; the cookie is HttpOnly and SameSite=Strict.
    #[test]
    fn codes_are_single_use_and_mint_a_strict_http_only_cookie() {
        let sessions = sessions();
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000);
        let link = sessions.mint("127.0.0.1:18765", now);
        assert!(link.url.starts_with("http://127.0.0.1:18765/connect?code="));
        assert_eq!(link.code.len(), 19);
        let typed = link.code.to_ascii_lowercase().replace('-', " ");
        let cookie = sessions.redeem(&typed, now).unwrap();
        let text = cookie.to_str().unwrap();
        assert!(text.starts_with("butler_session_18765=v1."), "{text}");
        assert!(
            text.contains("HttpOnly") && text.contains("SameSite=Strict"),
            "{text}"
        );
        assert!(sessions.redeem(&link.code, now).is_none(), "code reused");
        assert!(sessions.has_session(&cookie_header(&cookie), now));
        let later = now + Duration::from_secs(SESSION_TTL_SECONDS + 1);
        assert!(!sessions.has_session(&cookie_header(&cookie), later));
        let other_port = BrowserSessions::new(SigningKey::derive("token-for-session-tests"), 1);
        assert!(!other_port.has_session(&cookie_header(&cookie), now));
        let rotated = BrowserSessions::new(SigningKey::derive("rotated-token"), 18765);
        assert!(!rotated.has_session(&cookie_header(&cookie), now));

        let expired = sessions.mint("127.0.0.1:18765", now);
        assert!(sessions.redeem(&expired.code, now + CODE_TTL).is_none());
    }
}
