//! Request admission for the App gateway, in order: Host check, Origin
//! allowlist, CORS preflight (before auth), then one credential: the bearer
//! token, the browser-session cookie from a connection code, or a signed
//! URL for one message file.

mod browser_session;
mod connect_page;
mod cors;
mod request_policy;
mod signed_urls;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, Method, Request, StatusCode, Uri, header};
use axum::response::Response;

pub(super) use cors::{apply as apply_cors, preflight};
pub(super) use request_policy::{RequestOrigin, require_json_body};

use super::{HttpError, error::json, static_ui};
use crate::gateway::auth::{self, LocalAuthConfig};
use crate::gateway::crypto::{constant_time_eq, hmac_sha256, hmac_sha256_base64};
use crate::gateway::protocol::{APP_PROTOCOL_VERSION, ApiEnvelope};
use browser_session::BrowserSessions;
use connect_page::ConnectPage;
use request_policy::RequestPolicy;
use signed_urls::ResourceSigner;

/// `GET /connect?code=..`: redeems a connection code (no credential needed).
const CONNECT_PATH: &str = "/connect";
/// `POST /connection-codes`: mints a one-time browser link (bearer only).
pub(super) const CONNECTION_CODES_PATH: &str = "/connection-codes";

/// The key for signed URLs and session cookies, derived from the local
/// token: rotating the token revokes every link, URL and browser session.
#[derive(Clone)]
struct SigningKey([u8; 32]);

impl SigningKey {
    fn derive(token: &str) -> Self {
        Self(hmac_sha256(
            token.as_bytes(),
            b"butler.gateway.signing-key.v1",
        ))
    }

    fn mac(&self, message: &str) -> String {
        hmac_sha256_base64(&self.0, message.as_bytes())
    }

    fn verify(&self, message: &str, candidate: &str) -> bool {
        constant_time_eq(self.mac(message).as_bytes(), candidate.as_bytes())
    }
}

/// How a request proved it may use the gateway.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Access {
    /// Local auth is off (an embedding without a token, such as tests).
    AuthDisabled,
    /// A static UI asset (script, style, image), public by design.
    PublicAsset,
    /// `Authorization: Bearer <token>`.
    Bearer,
    /// The session cookie a redeemed connection code set.
    BrowserSession,
    /// A valid signature for this one message-file URL.
    SignedResource,
}

impl Access {
    /// Responses to these requests get `signed_url`s.
    fn receives_signed_urls(self) -> bool {
        matches!(
            self,
            Self::AuthDisabled | Self::Bearer | Self::BrowserSession
        )
    }
}

/// The outcome of [`GatewaySecurity::authorize`].
pub(super) enum Admission {
    /// Route the request with this access.
    Granted(Access),
    /// Answer without routing (connection page, code redemption).
    Respond(Response),
}

/// Why a request has no usable credential.
enum Denial {
    Unconfigured,
    Missing,
    OriginRequired,
}

impl From<Denial> for HttpError {
    fn from(denial: Denial) -> Self {
        match denial {
            Denial::Unconfigured => HttpError::public(
                503,
                "local_auth_unconfigured",
                "Butler App local auth is not configured.",
            ),
            Denial::Missing => HttpError::public(
                401,
                "local_auth_required",
                "Butler App local auth is required.",
            ),
            Denial::OriginRequired => HttpError::public(
                403,
                "origin_required",
                "Browser requests that change state must come from the Butler page.",
            ),
        }
    }
}

/// Host/Origin policy, credentials and signing for one gateway listener.
pub(super) struct GatewaySecurity {
    policy: RequestPolicy,
    auth: LocalAuthConfig,
    signer: Option<Arc<ResourceSigner>>,
    sessions: Option<BrowserSessions>,
}

impl GatewaySecurity {
    pub(super) fn new(
        auth: LocalAuthConfig,
        local_addr: SocketAddr,
        allowed_hosts: &[String],
        dev_origins: Option<&str>,
        signed_url_ttl: Duration,
    ) -> Self {
        let key = auth.token().map(SigningKey::derive);
        let ttl_seconds = signed_url_ttl.as_secs().max(1);
        Self {
            policy: RequestPolicy::new(local_addr, allowed_hosts, dev_origins),
            signer: key
                .clone()
                .map(|key| Arc::new(ResourceSigner::new(key, ttl_seconds))),
            sessions: key.map(|key| BrowserSessions::new(key, local_addr.port())),
            auth,
        }
    }

    /// Host check, then Origin classification (every request, before CORS).
    pub(super) fn admit(&self, headers: &HeaderMap) -> Result<RequestOrigin, HttpError> {
        self.policy.check_host(headers)?;
        self.policy.classify_origin(headers)
    }

    /// Decides the request's credential, or answers it directly.
    pub(super) fn authorize(
        &self,
        request: &Request<Body>,
        origin: &RequestOrigin,
    ) -> Result<Admission, HttpError> {
        let (method, uri, headers) = (request.method(), request.uri(), request.headers());
        let now = SystemTime::now();
        if *method == Method::GET && uri.path() == CONNECT_PATH {
            return Ok(Admission::Respond(self.connect(uri, now)));
        }
        if static_ui::is_public_asset(method, uri.path()) {
            return Ok(Admission::Granted(Access::PublicAsset));
        }
        match self.credential(method, uri, headers, origin, now) {
            Ok(access) => Ok(Admission::Granted(access)),
            Err(Denial::Missing) if *method == Method::GET && static_ui::accepts_html(headers) => {
                Ok(Admission::Respond(ConnectPage::SessionRequired.response()))
            }
            Err(denial) => Err(denial.into()),
        }
    }

    fn credential(
        &self,
        method: &Method,
        uri: &Uri,
        headers: &HeaderMap,
        origin: &RequestOrigin,
        now: SystemTime,
    ) -> Result<Access, Denial> {
        if !self.auth.required {
            return Ok(Access::AuthDisabled);
        }
        let token = self.auth.token().ok_or(Denial::Unconfigured)?;
        if auth::bearer_matches(headers, token) {
            return Ok(Access::Bearer);
        }
        if self
            .sessions
            .as_ref()
            .is_some_and(|sessions| sessions.has_session(headers, now))
        {
            // Browsers send Origin on every state-changing request; one
            // without it did not come from the Butler page.
            let safe = matches!(*method, Method::GET | Method::HEAD);
            if !safe && origin.allowed().is_none() {
                return Err(Denial::OriginRequired);
            }
            return Ok(Access::BrowserSession);
        }
        let signed = *method == Method::GET
            && self
                .signer
                .as_ref()
                .is_some_and(|signer| signer.verify(uri.path(), uri.query(), unix_seconds(now)));
        if signed {
            Ok(Access::SignedResource)
        } else {
            Err(Denial::Missing)
        }
    }

    /// `GET /connect[?code=..]`: the code page, or a session cookie and a
    /// redirect to the App.
    fn connect(&self, uri: &Uri, now: SystemTime) -> Response {
        let code = url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes())
            .find(|(name, _)| name == "code")
            .map(|(_, value)| value.into_owned())
            .filter(|value| !value.trim().is_empty());
        let Some(code) = code else {
            return ConnectPage::Ask.response();
        };
        let Some(cookie) = self
            .sessions
            .as_ref()
            .and_then(|sessions| sessions.redeem(&code, now))
        else {
            return ConnectPage::Rejected.response();
        };
        let mut response = Response::new(Body::empty());
        *response.status_mut() = StatusCode::SEE_OTHER;
        let headers = response.headers_mut();
        headers.insert(header::SET_COOKIE, cookie);
        headers.insert(header::LOCATION, header::HeaderValue::from_static("/"));
        headers.insert(
            header::CACHE_CONTROL,
            header::HeaderValue::from_static("no-store"),
        );
        headers.insert(
            header::REFERRER_POLICY,
            header::HeaderValue::from_static("no-referrer"),
        );
        response
    }

    /// `POST /connection-codes`: a one-time link for `butler open`.
    pub(super) fn mint_connection_code(
        &self,
        access: Access,
        headers: &HeaderMap,
    ) -> Result<Response, HttpError> {
        if !matches!(access, Access::Bearer | Access::AuthDisabled) {
            return Err(HttpError::public(
                403,
                "bearer_token_required",
                "Connection codes are issued to the local token only.",
            ));
        }
        let sessions = self.sessions.as_ref().ok_or(Denial::Unconfigured)?;
        let authority = headers
            .get(header::HOST)
            .and_then(|value| value.to_str().ok())
            .ok_or(Denial::Missing)?;
        json(
            StatusCode::CREATED,
            ApiEnvelope {
                protocol_version: APP_PROTOCOL_VERSION,
                data: sessions.mint(authority, SystemTime::now()),
            },
        )
    }

    /// Adds `signed_url`s to an authenticated JSON response.
    pub(super) async fn sign_urls(&self, access: Access, response: Response) -> Response {
        match &self.signer {
            Some(signer) if access.receives_signed_urls() => {
                signer
                    .decorate_response(response, unix_seconds(SystemTime::now()))
                    .await
            }
            _ => response,
        }
    }

    /// Adds `signed_url`s to live-event chunks (the stream is authenticated).
    pub(super) fn live_chunk_signer(&self) -> Option<impl Fn(Bytes) -> Bytes + Send + 'static> {
        let signer = self.signer.clone()?;
        Some(move |chunk| signer.decorate_event_chunk(chunk, unix_seconds(SystemTime::now())))
    }
}

fn unix_seconds(time: SystemTime) -> u64 {
    time.duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs())
}
