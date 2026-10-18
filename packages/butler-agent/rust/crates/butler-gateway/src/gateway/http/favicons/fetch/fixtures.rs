//! An explicit loopback origin for stub HTTP, absent from shipped builds.
use reqwest::Url;
use std::net::{IpAddr, SocketAddr};

pub(super) fn root() -> Option<Url> {
    let url = Url::parse(&std::env::var("BUTLER_E2E_FAVICON_ORIGIN").ok()?).ok()?;
    if url.scheme() != "http"
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    address(&url).filter(|address| address.ip().is_loopback())?;
    Some(url)
}
pub(super) fn addresses(url: &Url) -> Option<Vec<SocketAddr>> {
    if url.origin() != root()?.origin() || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    Some(vec![address(url)?])
}
fn address(url: &Url) -> Option<SocketAddr> {
    let ip = match url.host()? {
        url::Host::Ipv4(ip) => IpAddr::V4(ip),
        url::Host::Ipv6(ip) => IpAddr::V6(ip),
        url::Host::Domain(_) => return None,
    };
    Some(SocketAddr::new(ip, url.port_or_known_default()?))
}
