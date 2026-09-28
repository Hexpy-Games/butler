//! Request admission for the App gateway, in order: Host check, Origin
//! allowlist, CORS preflight (before auth), then one credential: the bearer
//! token, the browser-session cookie from a connection code (used only by
//! the Butler page itself, see [`fetch_metadata`]), or a signed URL for one
//! message file.
//!
//! The Host/Origin policy and the token can change while the gateway runs
//! (Settings → Security): each request reads the current ones.

mod browser_session;
mod client_place;
mod connect_page;
mod cors;
mod fetch_metadata;
mod keys;
pub(super) mod lan;
mod request_policy;
mod signed_urls;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, HeaderValue, Method, Request, StatusCode, Uri, header};
use axum::response::Response;
use parking_lot::RwLock;
use tokio_util::sync::CancellationToken;

pub(super) use client_place::is_local_client;
pub(super) use cors::{apply as apply_cors, preflight};
pub(super) use request_policy::{RequestOrigin, require_json_body};

use super::{HttpError, error::json, static_ui};
use crate::gateway::auth::{self, LocalAuthConfig};
use crate::gateway::protocol::{APP_PROTOCOL_VERSION, ApiEnvelope};
use connect_page::ConnectPage;
use fetch_metadata::{SessionRefusal, SessionRequest};
use keys::{Keyed, SigningKey};
use request_policy::RequestPolicy;

/// `GET /connect?code=..`: redeems a connection code (no credential needed).
const CONNECT_PATH: &str = "/connect";
/// `POST /connection-codes`: mints a one-time browser link (bearer only).
pub(super) const CONNECTION_CODES_PATH: &str = "/connection-codes";

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
    /// A session cookie request without the Butler page's Origin.
    OriginRequired,
    /// A session cookie request another origin of the site sent.
    ForeignSite,
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
                "Browser requests must come from the Butler page.",
            ),
            Denial::ForeignSite => HttpError::public(
                403,
                "cross_site_session",
                "This browser session only answers the Butler page.",
            ),
        }
    }
}

/// Host/Origin policy, credentials and signing for one gateway.
pub(super) struct GatewaySecurity {
    auth: LocalAuthConfig,
    local_addr: SocketAddr,
    dev_origins: Option<String>,
    ttl_seconds: u64,
    shutdown: CancellationToken,
    policy: RwLock<Arc<RequestPolicy>>,
    keyed: RwLock<Arc<Keyed>>,
}

impl GatewaySecurity {
    pub(super) fn new(
        auth: LocalAuthConfig,
        local_addr: SocketAddr,
        allowed_hosts: &[String],
        dev_origins: Option<String>,
        signed_url_ttl: Duration,
        shutdown: CancellationToken,
    ) -> Self {
        let ttl_seconds = signed_url_ttl.as_secs().max(1);
        let keyed = Keyed::derive(auth.token(), local_addr.port(), ttl_seconds, &shutdown);
        let policy = RequestPolicy::new(local_addr, allowed_hosts, dev_origins.as_deref(), &[]);
        Self {
            auth,
            local_addr,
            dev_origins,
            ttl_seconds,
            shutdown,
            policy: RwLock::new(Arc::new(policy)),
            keyed: RwLock::new(Arc::new(keyed)),
        }
    }

    /// Host check, then Origin classification (every request, before CORS).
    pub(super) fn admit(&self, headers: &HeaderMap) -> Result<RequestOrigin, HttpError> {
        let policy = self.policy.read().clone();
        policy.check_host(headers)?;
        policy.classify_origin(headers)
    }

    /// Answers `allowed_hosts` and the LAN authorities from now on.
    pub(super) fn set_hosts(&self, allowed_hosts: &[String], lan_authorities: &[String]) {
        let policy = RequestPolicy::new(
            self.local_addr,
            allowed_hosts,
            self.dev_origins.as_deref(),
            lan_authorities,
        );
        *self.policy.write() = Arc::new(policy);
    }

    /// The current token (the connection code), when there is one.
    pub(super) fn token(&self) -> Option<Arc<str>> {
        self.keyed.read().token.clone()
    }

    /// Makes `token` the only credential from now on: the old token, its
    /// signed URLs, browser sessions and pending connection codes stop
    /// working. Returns the old token's live-stream closer, to cancel once
    /// those streams got the rotation event; `None` when there is no token
    /// to replace.
    pub(super) fn rotate(&self, token: &str) -> Option<CancellationToken> {
        let mut keyed = self.keyed.write();
        if keyed.token.is_none() || !self.auth.replace_token(token) {
            return None;
        }
        let next = Keyed::derive(
            Some(Arc::from(token)),
            self.local_addr.port(),
            self.ttl_seconds,
            &self.shutdown,
        );
        let previous = std::mem::replace(&mut *keyed, Arc::new(next));
        Some(previous.streams.clone())
    }

    /// A new browser-session cookie under the current key.
    pub(super) fn issue_session(&self) -> Option<HeaderValue> {
        let keyed = self.keyed.read().clone();
        keyed.sessions.as_ref()?.issue(SystemTime::now())
    }

    /// Closes live streams opened under the current token when it rotates.
    pub(super) fn live_streams(&self) -> CancellationToken {
        self.keyed.read().streams.clone()
    }

    /// Decides the request's credential, or answers it directly.
    pub(super) fn authorize(
        &self,
        request: &Request<Body>,
        origin: &RequestOrigin,
    ) -> Result<Admission, HttpError> {
        let (method, uri, headers) = (request.method(), request.uri(), request.headers());
        let now = SystemTime::now();
        let keyed = self.keyed.read().clone();
        if *method == Method::GET && uri.path() == CONNECT_PATH {
            return Ok(Admission::Respond(connect(&keyed, uri, now)));
        }
        if static_ui::is_public_asset(method, uri.path()) {
            return Ok(Admission::Granted(Access::PublicAsset));
        }
        let request = CredentialRequest {
            method,
            uri,
            headers,
            origin,
            now,
        };
        match self.credential(&keyed, &request) {
            Ok(access) => Ok(Admission::Granted(access)),
            // A navigation without a usable session (none, or one another
            // local page's link carried) gets the connection-code screen.
            Err(Denial::Missing | Denial::ForeignSite)
                if *method == Method::GET && static_ui::accepts_html(headers) =>
            {
                Ok(Admission::Respond(ConnectPage::SessionRequired.response()))
            }
            Err(denial) => Err(denial.into()),
        }
    }

    fn credential(&self, keyed: &Keyed, request: &CredentialRequest<'_>) -> Result<Access, Denial> {
        if !self.auth.required {
            return Ok(Access::AuthDisabled);
        }
        let token = keyed.token.as_deref().ok_or(Denial::Unconfigured)?;
        let CredentialRequest {
            method,
            uri,
            headers,
            origin,
            now,
        } = *request;
        if auth::bearer_matches(headers, token) {
            return Ok(Access::Bearer);
        }
        let session_refusal = if keyed
            .sessions
            .as_ref()
            .is_some_and(|sessions| sessions.has_session(headers, now))
        {
            let refusal = fetch_metadata::session_use(SessionRequest {
                method,
                headers,
                origin_allowed: origin.allowed().is_some(),
                loopback_host: request_policy::is_loopback_host(headers),
            });
            match refusal {
                Ok(()) => return Ok(Access::BrowserSession),
                Err(refusal) => Some(refusal),
            }
        } else {
            None
        };
        // A signature is its own credential, whatever cookie comes with it.
        let signed = *method == Method::GET
            && keyed
                .signer
                .as_ref()
                .is_some_and(|signer| signer.verify(uri.path(), uri.query(), unix_seconds(now)));
        if signed {
            return Ok(Access::SignedResource);
        }
        Err(match session_refusal {
            Some(SessionRefusal::ForeignSite) => Denial::ForeignSite,
            Some(SessionRefusal::OriginRequired) => Denial::OriginRequired,
            None => Denial::Missing,
        })
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
        let keyed = self.keyed.read().clone();
        let sessions = keyed.sessions.as_ref().ok_or(Denial::Unconfigured)?;
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
        let signer = self.keyed.read().signer.clone();
        match signer {
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
        let signer = self.keyed.read().signer.clone()?;
        Some(move |chunk| signer.decorate_event_chunk(chunk, unix_seconds(SystemTime::now())))
    }
}

/// The request facts a credential is judged on.
#[derive(Clone, Copy)]
struct CredentialRequest<'a> {
    method: &'a Method,
    uri: &'a Uri,
    headers: &'a HeaderMap,
    origin: &'a RequestOrigin,
    now: SystemTime,
}

/// `GET /connect[?code=..]`: the code page, or a session cookie and a
/// redirect to the App.
fn connect(keyed: &Keyed, uri: &Uri, now: SystemTime) -> Response {
    let code = url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes())
        .find(|(name, _)| name == "code")
        .map(|(_, value)| value.into_owned())
        .filter(|value| !value.trim().is_empty());
    let Some(code) = code else {
        return ConnectPage::Ask.response();
    };
    let Some(cookie) = keyed
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
    headers.insert(header::LOCATION, HeaderValue::from_static("/"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
}

fn unix_seconds(time: SystemTime) -> u64 {
    time.duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs())
}
