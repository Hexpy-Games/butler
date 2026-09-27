//! Which requests may use a browser session, by Fetch Metadata.
//!
//! The session cookie is host-only and SameSite=Strict, yet browsers send it
//! to every port of the host and count the other ports as the same site: a
//! page on another local port (a dev server, a preview an agent tool
//! started) can make cookie-bearing requests, and its `no-cors` GETs carry
//! no Origin. Browsers name a request's initiator in `Sec-Fetch-Site` on
//! loopback and HTTPS; only the Butler page itself (`same-origin`) and the
//! user (`none`: the address bar, a bookmark, the link `butler open`
//! opened) may use the session. Plain-HTTP LAN names get no Fetch Metadata,
//! so there a GET is admitted without it and a state change still needs the
//! page's own Origin.

use axum::http::{HeaderMap, Method};

const SEC_FETCH_SITE: &str = "sec-fetch-site";

/// A request's `Sec-Fetch-Site`, which pages cannot set themselves.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FetchSite {
    /// `same-origin`: the Butler page itself.
    SameOrigin,
    /// `none`: the user navigated (address bar, bookmark, an opened link).
    UserInitiated,
    /// `same-site` (another port of this host), `cross-site`, a repeated
    /// header or a value this gateway does not know.
    Foreign,
    /// No header: a plain-HTTP LAN name, a browser without Fetch Metadata,
    /// or a client that is not a browser.
    Absent,
}

impl FetchSite {
    fn of(headers: &HeaderMap) -> Self {
        let mut values = headers.get_all(SEC_FETCH_SITE).iter();
        match (values.next(), values.next()) {
            (None, _) => Self::Absent,
            (Some(value), None) => match value.as_bytes() {
                b"same-origin" => Self::SameOrigin,
                b"none" => Self::UserInitiated,
                _ => Self::Foreign,
            },
            (Some(_), Some(_)) => Self::Foreign,
        }
    }
}

/// Why a request with a valid session cookie may not use it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::gateway::http) enum SessionRefusal {
    /// Another origin of this site, or another site, sent it.
    ForeignSite,
    /// It needs the Butler page's Origin: a state change, or a request to a
    /// loopback name without Fetch Metadata.
    OriginRequired,
}

/// The request facts the session rule reads.
#[derive(Clone, Copy, Debug)]
pub(in crate::gateway::http) struct SessionRequest<'a> {
    pub(in crate::gateway::http) method: &'a Method,
    pub(in crate::gateway::http) headers: &'a HeaderMap,
    /// The request's Origin is on the allowlist.
    pub(in crate::gateway::http) origin_allowed: bool,
    /// The Host is a loopback name, where every current browser sends
    /// Fetch Metadata.
    pub(in crate::gateway::http) loopback_host: bool,
}

/// Whether a request carrying a valid session cookie may use it.
pub(in crate::gateway::http) fn session_use(
    request: SessionRequest<'_>,
) -> Result<(), SessionRefusal> {
    let reads_admitted = match FetchSite::of(request.headers) {
        FetchSite::Foreign => return Err(SessionRefusal::ForeignSite),
        FetchSite::SameOrigin | FetchSite::UserInitiated => true,
        FetchSite::Absent => !request.loopback_host,
    };
    // Browsers send Origin on every state-changing request; one without the
    // page's own Origin did not come from the Butler page.
    let safe = matches!(*request.method, Method::GET | Method::HEAD);
    if request.origin_allowed || (safe && reads_admitted) {
        Ok(())
    } else {
        Err(SessionRefusal::OriginRequired)
    }
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;

    use super::*;

    /// Security boundary: which cookie requests may use the browser session.
    #[test]
    fn only_the_butler_page_and_the_user_use_the_session() {
        use SessionRefusal::{ForeignSite, OriginRequired};
        // Method, Sec-Fetch-Site, allowed Origin, loopback Host, outcome.
        let cases: [(Method, Option<&str>, bool, bool, Result<(), SessionRefusal>); 14] = [
            (Method::GET, Some("same-origin"), false, true, Ok(())),
            (Method::GET, Some("none"), false, true, Ok(())),
            (Method::HEAD, Some("same-origin"), false, true, Ok(())),
            (
                Method::GET,
                Some("same-site"),
                false,
                true,
                Err(ForeignSite),
            ),
            (Method::GET, Some("same-site"), true, true, Err(ForeignSite)),
            (
                Method::GET,
                Some("cross-site"),
                false,
                false,
                Err(ForeignSite),
            ),
            (
                Method::GET,
                Some("SAME-ORIGIN"),
                false,
                true,
                Err(ForeignSite),
            ),
            (Method::PATCH, Some("same-origin"), true, true, Ok(())),
            (
                Method::PATCH,
                Some("same-origin"),
                false,
                true,
                Err(OriginRequired),
            ),
            (Method::POST, Some("none"), false, true, Err(OriginRequired)),
            (Method::GET, None, false, true, Err(OriginRequired)),
            (Method::GET, None, true, true, Ok(())),
            (Method::GET, None, false, false, Ok(())),
            (Method::DELETE, None, false, false, Err(OriginRequired)),
        ];
        for (method, site, origin_allowed, loopback_host, expected) in cases {
            let mut headers = HeaderMap::new();
            if let Some(site) = site {
                headers.insert(SEC_FETCH_SITE, HeaderValue::from_str(site).unwrap());
            }
            let outcome = session_use(SessionRequest {
                method: &method,
                headers: &headers,
                origin_allowed,
                loopback_host,
            });
            assert_eq!(
                outcome, expected,
                "{method} {site:?} {origin_allowed} {loopback_host}"
            );
        }
        let mut repeated = HeaderMap::new();
        repeated.append(SEC_FETCH_SITE, HeaderValue::from_static("same-origin"));
        repeated.append(SEC_FETCH_SITE, HeaderValue::from_static("same-origin"));
        let outcome = session_use(SessionRequest {
            method: &Method::GET,
            headers: &repeated,
            origin_allowed: false,
            loopback_host: true,
        });
        assert_eq!(outcome, Err(ForeignSite));
    }
}
