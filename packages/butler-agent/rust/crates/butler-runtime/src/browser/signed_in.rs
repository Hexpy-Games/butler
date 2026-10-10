//! Signed-in browsing policy: which sites, identity pages and frames a
//! conversation's signed-in tab may reach. Lists change only by release.
use serde_json::{Value, json};

/// Identity-provider pages a signed-in tab may pass through during a sign-in
/// redirect: host plus allowed path prefixes (empty = any path). Acting on one
/// still needs a grant for that provider's own site.
pub const IDP_PAGES: &[(&str, &[&str])] = &[
    ("accounts.google.com", &[]),
    ("login.microsoftonline.com", &[]),
    ("login.live.com", &[]),
    ("appleid.apple.com", &[]),
    ("github.com", &["/login", "/session", "/sessions/"]),
    ("kauth.kakao.com", &[]),
    ("accounts.kakao.com", &[]),
    ("nid.naver.com", &[]),
];

/// Utility frames (address search) that act under the parent site's grant.
pub const UTILITY_FRAME_HOSTS: &[&str] = &[
    "postcode.map.daum.net",
    "postcode.map.kakao.com",
    "t1.daumcdn.net",
    "t1.kakaocdn.net",
];

/// How a frame inside a signed-in tab is treated (decision 25).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameClass {
    /// Same site as a granted site, or a frame grant.
    Granted,
    /// Release-maintained utility frame; acts under the parent grant.
    Utility,
    /// Payment widget: labels only, a card for every act.
    Payment,
    /// Anything else: unavailable until the user grants it for this conversation.
    Unknown,
}

impl FrameClass {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Granted => "granted",
            Self::Utility => "utility",
            Self::Payment => "payment",
            Self::Unknown => "unknown",
        }
    }
}

/// The registrable site (eTLD+1) of an http(s) URL; an IP literal is its own site.
pub fn site_of(raw: &str) -> Option<String> {
    let url = url::Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    site_of_host(url.host_str()?)
}

pub fn site_of_host(host: &str) -> Option<String> {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() {
        return None;
    }
    if host.parse::<std::net::IpAddr>().is_ok() || host.starts_with('[') {
        return Some(host);
    }
    Some(psl::domain_str(&host).unwrap_or(&host).to_owned())
}

/// The signed-in authority target for a site.
pub fn signed_in_scope(site: &str) -> String {
    format!("browser:signed_in:{site}")
}

/// Whether a URL is an identity-provider page a signed-in tab may pass through.
pub fn idp_page(raw: &str) -> bool {
    let Ok(url) = url::Url::parse(raw) else {
        return false;
    };
    url.scheme() == "https"
        && url.host_str().is_some_and(|host| {
            IDP_PAGES.iter().any(|(page, prefixes)| {
                *page == host
                    && (prefixes.is_empty() || prefixes.iter().any(|p| url.path().starts_with(p)))
            })
        })
}

/// Where a signed-in tab's top-level URL stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SignedInPlace {
    /// A granted site: observe and act.
    Granted,
    /// An identity page on the way back: observe only until its site is granted.
    Identity,
    /// Not reachable from this conversation.
    Denied,
}

pub fn signed_in_place(raw: &str, sites: &[String]) -> SignedInPlace {
    if super::public_url(raw).is_err() {
        return SignedInPlace::Denied;
    }
    match site_of(raw) {
        Some(site) if sites.contains(&site) => SignedInPlace::Granted,
        _ if idp_page(raw) => SignedInPlace::Identity,
        _ => SignedInPlace::Denied,
    }
}

/// Classifies a frame URL inside a signed-in tab whose page is on `top_site`.
pub fn frame_class(raw: &str, top_site: &str, sites: &[String], frames: &[String]) -> FrameClass {
    if matches!(raw, "about:blank" | "about:srcdoc" | "") {
        return FrameClass::Granted;
    }
    let host = url::Url::parse(raw)
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase));
    let Some(host) = host else {
        return FrameClass::Unknown;
    };
    let site = site_of_host(&host).unwrap_or_default();
    if super::payment_host(&host) {
        return FrameClass::Payment;
    }
    if site == top_site || sites.contains(&site) || frames.contains(&frame_key(top_site, &site)) {
        return FrameClass::Granted;
    }
    if UTILITY_FRAME_HOSTS.contains(&host.as_str()) {
        return FrameClass::Utility;
    }
    FrameClass::Unknown
}

/// The stored key of a frame grant: `<site>:<frame site>`.
pub fn frame_key(site: &str, frame_site: &str) -> String {
    format!("{site}:{frame_site}")
}

/// The policy main enforces on a signed-in conversation tab. Rust decides;
/// main only applies it and reports frames back for re-checking.
pub fn signed_in_policy(content_origin: &str, sites: &[String], frames: &[String]) -> Value {
    json!({
        "mode": "signed_in",
        "content_origin": content_origin,
        "secure_keypads": super::SECURE_KEYPAD_MARKERS,
        "sites": sites,
        "frame_grants": frames,
        "idp_pages": IDP_PAGES.iter().map(|(host, paths)| json!({"host": host, "site": site_of_host(host), "paths": paths})).collect::<Vec<_>>(),
        "utility_hosts": UTILITY_FRAME_HOSTS,
        "payment_sites": super::PAYMENT_SITES,
        "popup_sites": sites,
        "popup_hosts": super::POPUP_HOSTS,
    })
}

/// Rust's re-check of the frames main reported for a signed-in observation:
/// an unknown frame must never carry page content, and every class must match.
pub fn frames_consistent(
    frames: &[Value],
    top_site: &str,
    sites: &[String],
    grants: &[String],
) -> bool {
    frames.iter().all(|frame| {
        let url = frame["url"].as_str().unwrap_or("");
        let class = frame_class(url, top_site, sites, grants);
        match frame["class"].as_str() {
            Some(reported) => {
                reported == class.as_str() || (reported == "main" && frame["id"] == "f0")
            }
            None => class != FrameClass::Unknown,
        }
    })
}
