//! Everything the gateway derives from its token. Rotating the connection
//! code replaces the whole set at once: the token, the signing key of
//! signed URLs and browser sessions, pending connection codes, and the
//! live streams opened under the old token.

use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use super::browser_session::BrowserSessions;
use super::signed_urls::ResourceSigner;
use crate::gateway::crypto::{constant_time_eq, hmac_sha256, hmac_sha256_base64};

/// The key for signed URLs and session cookies, derived from the local
/// token: rotating the token revokes every link, URL and browser session.
#[derive(Clone)]
pub(super) struct SigningKey([u8; 32]);

impl SigningKey {
    pub(super) fn derive(token: &str) -> Self {
        Self(hmac_sha256(
            token.as_bytes(),
            b"butler.gateway.signing-key.v1",
        ))
    }

    pub(super) fn mac(&self, message: &str) -> String {
        hmac_sha256_base64(&self.0, message.as_bytes())
    }

    pub(super) fn verify(&self, message: &str, candidate: &str) -> bool {
        constant_time_eq(self.mac(message).as_bytes(), candidate.as_bytes())
    }
}

/// One token and what it keys.
pub(super) struct Keyed {
    /// The bearer token (none when local auth is off or unconfigured).
    pub(super) token: Option<Arc<str>>,
    pub(super) signer: Option<Arc<ResourceSigner>>,
    pub(super) sessions: Option<BrowserSessions>,
    /// Closes the live streams opened while this token was current.
    pub(super) streams: CancellationToken,
}

impl Keyed {
    /// Derives the set for `token`; its streams close with `shutdown`.
    pub(super) fn derive(
        token: Option<Arc<str>>,
        port: u16,
        ttl_seconds: u64,
        shutdown: &CancellationToken,
    ) -> Self {
        let key = token.as_deref().map(SigningKey::derive);
        Self {
            signer: key
                .clone()
                .map(|key| Arc::new(ResourceSigner::new(key, ttl_seconds))),
            sessions: key.map(|key| BrowserSessions::new(key, port)),
            token,
            streams: shutdown.child_token(),
        }
    }
}
