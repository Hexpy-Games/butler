//! Which requests may use a browser session, by Fetch Metadata.
//!
//! The session cookie is host-only and SameSite=Lax, and browsers send it
//! to every port of the host: a page on another local port (a dev server, a
//! preview an agent tool started) can make cookie-bearing requests, and its
//! `no-cors` GETs carry no Origin. Browsers name a request's initiator in
//! `Sec-Fetch-Site` on loopback and HTTPS; the Butler page itself
//! (`same-origin`) and the user (`none`: the address bar, a bookmark) may
//! use the session. A top-level navigation to the Butler page from another
//! site or app (a messenger link, an OAuth return) is the user opening
//! Butler too: it only shows the page to that user (`frame-ancestors 'none'`
//! blocks frames), and every API request still needs the page itself.
//! Plain-HTTP LAN names get no Fetch Metadata, so there a GET is admitted
//! without it and a state change still needs the page's own Origin.

use axum::http::{HeaderMap, Method};

use super::super::HttpError;

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

/// A form POST to `/connect` may omit Fetch Metadata on plain HTTP LAN
/// pages, but browsers that send it must identify the page itself.
pub(super) fn connect_post_site(headers: &HeaderMap) -> Result<(), HttpError> {
    match FetchSite::of(headers) {
        FetchSite::Absent | FetchSite::SameOrigin => Ok(()),
        FetchSite::UserInitiated | FetchSite::Foreign => Err(HttpError::public(
            403,
            "origin_not_allowed",
            "Requests from this origin are not allowed.",
        )),
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
    /// The request would be answered with the Butler page itself (router::serves_ui).
    pub(in crate::gateway::http) ui_page: bool,
}

fn is_page_navigation(headers: &HeaderMap) -> bool {
    let mut modes = headers.get_all("sec-fetch-mode").iter();
    let mut destinations = headers.get_all("sec-fetch-dest").iter();
    matches!((modes.next(), modes.next()), (Some(value), None) if value.as_bytes() == b"navigate")
        && matches!((destinations.next(), destinations.next()), (Some(value), None) if value.as_bytes() == b"document")
}

/// Whether a request carrying a valid session cookie may use it.
pub(in crate::gateway::http) fn session_use(
    request: SessionRequest<'_>,
) -> Result<(), SessionRefusal> {
    let safe = matches!(*request.method, Method::GET | Method::HEAD);
    let reads_admitted = match FetchSite::of(request.headers) {
        FetchSite::Foreign => {
            if safe && request.ui_page && is_page_navigation(request.headers) {
                true
            } else {
                return Err(SessionRefusal::ForeignSite);
            }
        }
        FetchSite::SameOrigin | FetchSite::UserInitiated => true,
        FetchSite::Absent => !request.loopback_host,
    };
    // Browsers send Origin on every state-changing request; one without the
    // page's own Origin did not come from the Butler page.
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

    /// Method, Sec-Fetch-Site, allowed Origin, loopback Host, UI page, navigation, outcome.
    type Case = (
        Method,
        Option<&'static str>,
        bool,
        bool,
        bool,
        bool,
        Result<(), SessionRefusal>,
    );

    /// Security boundary: which cookie requests may use the browser session.
    #[test]
    fn only_the_butler_page_and_the_user_use_the_session() {
        use SessionRefusal::{ForeignSite, OriginRequired};
        let cases: [Case; 19] = [
            (
                Method::GET,
                Some("same-origin"),
                false,
                true,
                false,
                false,
                Ok(()),
            ),
            (Method::GET, Some("none"), false, true, false, false, Ok(())),
            (
                Method::HEAD,
                Some("same-origin"),
                false,
                true,
                false,
                false,
                Ok(()),
            ),
            (
                Method::GET,
                Some("same-site"),
                false,
                true,
                false,
                false,
                Err(ForeignSite),
            ),
            (
                Method::GET,
                Some("same-site"),
                true,
                true,
                false,
                false,
                Err(ForeignSite),
            ),
            (
                Method::GET,
                Some("cross-site"),
                false,
                false,
                false,
                false,
                Err(ForeignSite),
            ),
            (
                Method::GET,
                Some("SAME-ORIGIN"),
                false,
                true,
                false,
                false,
                Err(ForeignSite),
            ),
            (
                Method::PATCH,
                Some("same-origin"),
                true,
                true,
                false,
                false,
                Ok(()),
            ),
            (
                Method::PATCH,
                Some("same-origin"),
                false,
                true,
                false,
                false,
                Err(OriginRequired),
            ),
            (
                Method::POST,
                Some("none"),
                false,
                true,
                false,
                false,
                Err(OriginRequired),
            ),
            (
                Method::GET,
                None,
                false,
                true,
                false,
                false,
                Err(OriginRequired),
            ),
            (Method::GET, None, true, true, false, false, Ok(())),
            (Method::GET, None, false, false, false, false, Ok(())),
            (
                Method::DELETE,
                None,
                false,
                false,
                false,
                false,
                Err(OriginRequired),
            ),
            (
                Method::GET,
                Some("cross-site"),
                false,
                false,
                true,
                true,
                Ok(()),
            ),
            (
                Method::GET,
                Some("same-site"),
                false,
                true,
                true,
                true,
                Ok(()),
            ),
            (
                Method::GET,
                Some("cross-site"),
                false,
                false,
                false,
                true,
                Err(ForeignSite),
            ),
            (
                Method::GET,
                Some("cross-site"),
                false,
                false,
                true,
                false,
                Err(ForeignSite),
            ),
            (
                Method::POST,
                Some("same-site"),
                false,
                true,
                true,
                true,
                Err(ForeignSite),
            ),
        ];
        for (method, site, origin_allowed, loopback_host, ui_page, navigation, expected) in cases {
            let mut headers = HeaderMap::new();
            if let Some(site) = site {
                headers.insert(SEC_FETCH_SITE, HeaderValue::from_str(site).unwrap());
            }
            if navigation {
                headers.insert("sec-fetch-mode", HeaderValue::from_static("navigate"));
                headers.insert("sec-fetch-dest", HeaderValue::from_static("document"));
            }
            let outcome = session_use(SessionRequest {
                method: &method,
                headers: &headers,
                origin_allowed,
                loopback_host,
                ui_page,
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
            ui_page: false,
        });
        assert_eq!(outcome, Err(ForeignSite));
    }
}
