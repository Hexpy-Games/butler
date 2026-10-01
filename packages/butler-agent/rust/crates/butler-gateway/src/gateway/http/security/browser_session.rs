//! One-time browser links and foreground pairing: `butler open` asks for a one-time
//! connection code (`POST /connection-codes`, bearer token only) and opens
//! `/connect?code=<code>`, which trades the code for an HttpOnly,
//! SameSite=Strict per-device session cookie. Pairing codes live only in memory.

use std::collections::HashMap;
use std::time::{Duration, SystemTime};

use parking_lot::Mutex;
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::unix_seconds;
use crate::gateway::crypto::constant_time_eq;
use crate::gateway::crypto::random_bytes;

/// How long a connection code can be redeemed.
const CODE_TTL: Duration = Duration::from_secs(300);
/// Unredeemed codes kept at once; the oldest is dropped past this.
const MAX_PENDING_CODES: usize = 32;
/// Crockford base32: no I, L, O or U to misread when typed.
const CODE_ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_GROUPS: usize = 4;
const CODE_GROUP_LENGTH: usize = 4;

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
    pairing: Mutex<Option<Pairing>>,
    #[cfg(debug_assertions)]
    clock_offset: std::sync::atomic::AtomicU64,
    pending: Mutex<HashMap<[u8; 32], SystemTime>>,
}

impl BrowserSessions {
    pub(in crate::gateway::http) fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            pairing: Mutex::new(None),
            #[cfg(debug_assertions)]
            clock_offset: std::sync::atomic::AtomicU64::new(0),
        }
    }

    pub(in crate::gateway::http) fn now(&self) -> SystemTime {
        let now = SystemTime::now();
        #[cfg(debug_assertions)]
        let now =
            now + Duration::from_secs(self.clock_offset.load(std::sync::atomic::Ordering::Relaxed));
        now
    }

    #[cfg(debug_assertions)]
    pub(in crate::gateway::http) fn advance(&self, seconds: u64) {
        self.clock_offset
            .fetch_add(seconds, std::sync::atomic::Ordering::Relaxed);
    }

    pub(in crate::gateway::http) fn issue_pairing(&self) -> PairingCode {
        let mut slot = self.pairing.lock();
        let mut code = new_digits();
        while slot
            .as_ref()
            .is_some_and(|pin| constant_time_eq(&pin.digest, &code_digest(&code)))
        {
            code = new_digits();
        }
        let expires = self.now() + Duration::from_secs(60);
        let id = uuid::Uuid::new_v4().to_string();
        *slot = Some(Pairing {
            digest: code_digest(&code),
            failures: 0,
            expires,
            view: PairingStatus {
                id: id.clone(),
                expires_at: unix_seconds(expires),
                expires_in: 60,
                status: "active".into(),
                invalidated_by: None,
                device_id: None,
            },
        });
        PairingCode {
            id,
            code,
            expires_at: unix_seconds(expires),
            expires_in: 60,
        }
    }

    pub(in crate::gateway::http) fn pairing_status(&self) -> Option<PairingStatus> {
        let now = self.now();
        let mut slot = self.pairing.lock();
        if let Some(pin) = slot.as_mut()
            && pin.view.status == "active"
            && pin.expires <= now
        {
            pin.view.status = "expired".into();
        }
        slot.as_ref().map(|pin| {
            let mut view = pin.view.clone();
            view.expires_in = if view.status == "active" {
                pin.expires.duration_since(now).map_or(0, |duration| {
                    duration
                        .as_secs()
                        .saturating_add(u64::from(duration.subsec_nanos() > 0))
                })
            } else {
                0
            };
            view
        })
    }

    /// Both code kinds are single-use. Pairing is only checked on POST.
    pub(in crate::gateway::http) fn redeem(
        &self,
        code: &str,
        form: bool,
        ip: &str,
    ) -> Option<Option<String>> {
        let now = self.now();
        let digest = code_digest(code);
        if code.chars().filter(|c| !matches!(c, '-' | ' ')).count() == 16 {
            let mut pending = self.pending.lock();
            let key = pending
                .keys()
                .find(|key| constant_time_eq(&digest, key.as_slice()))
                .copied();
            if let Some(expiry) = key.and_then(|key| pending.remove(&key))
                && expiry > now
            {
                return Some(None);
            }
        }
        if !form {
            return None;
        }
        let mut slot = self.pairing.lock();
        let target = slot.as_ref().map_or([0; 32], |pin| pin.digest);
        let matches = constant_time_eq(&digest, &target);
        let pin = slot.as_mut()?;
        if pin.view.status != "active" || pin.expires <= now {
            return None;
        }
        if matches && code.len() == 8 && code.bytes().all(|b| b.is_ascii_digit()) {
            pin.view.status = "paired".into();
            return Some(Some(pin.view.id.clone()));
        }
        pin.failures += 1;
        if pin.failures >= 3 {
            pin.view.status = "invalidated".into();
            pin.view.invalidated_by = Some(ip.into());
        }
        None
    }

    pub(in crate::gateway::http) fn paired(&self, pairing_id: &str, id: &str) {
        if let Some(pin) = self.pairing.lock().as_mut()
            && pin.view.status == "paired"
            && pin.view.id == pairing_id
        {
            pin.view.device_id = Some(id.into());
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

#[derive(Clone, Serialize)]
pub(in crate::gateway::http) struct PairingStatus {
    pub id: String,
    pub expires_at: u64,
    pub expires_in: u64,
    pub status: String,
    pub invalidated_by: Option<String>,
    pub device_id: Option<String>,
}

#[derive(Serialize)]
pub(in crate::gateway::http) struct PairingCode {
    pub id: String,
    pub code: String,
    pub expires_at: u64,
    pub expires_in: u64,
}

struct Pairing {
    expires: SystemTime,
    digest: [u8; 32],
    failures: u8,
    view: PairingStatus,
}

/// Rejection sampling avoids modulo bias in decimal digits.
fn new_digits() -> String {
    let mut code = String::with_capacity(8);
    while code.len() < 8 {
        for byte in random_bytes() {
            if byte < 250 {
                code.push(char::from(b'0' + byte % 10));
                if code.len() == 8 {
                    break;
                }
            }
        }
    }
    code
}
