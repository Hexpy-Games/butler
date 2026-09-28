//! Settings → Security (#229): the contract between the gateway and the host
//! that owns its connection code (the data-folder token file) and its
//! network exposure (`gateways/app.json`).
//!
//! The gateway serves the API (`GET /security`, the connection-code routes
//! and `PATCH /settings {security}`), only to clients on this computer, and
//! applies changes live: LAN listeners bind and unbind without a restart, and
//! a rotated token replaces the old one for every request, signed URL,
//! browser session and live stream at once. The host persists them.

use std::net::{IpAddr, Ipv6Addr};

use super::ApplicationFuture;

/// Most extra host names one gateway answers.
pub const MAX_ALLOWED_HOSTS: usize = 32;
/// The request header that carries the local admin credential (the secret
/// in `app/runtime/auth/local-admin.json`), which Settings → Security
/// requires besides a loopback client.
pub const ADMIN_CREDENTIAL_HEADER: &str = "x-butler-admin";
/// Longest host name (RFC 1035), plus room for `:port`.
const MAX_HOST_LENGTH: usize = 253 + 6;

/// How far the gateway is exposed beyond loopback.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GatewayExposure {
    /// Also listen on the machine's LAN addresses, on the same port. Off:
    /// loopback only.
    pub remote_access_enabled: bool,
    /// Extra Host names (`name` or `name:port`) the gateway answers, such as
    /// the public name of a tunnel or reverse proxy the user runs.
    pub allowed_hosts: Vec<String>,
}

/// A connection code the host has just stored.
#[derive(Clone, Debug)]
pub struct RotatedConnectionCode {
    /// The new gateway token.
    pub code: String,
    /// When it was created (RFC 3339), as the token file records it.
    pub created_at: Option<String>,
}

/// The host side of Settings → Security.
pub trait GatewaySecurityStore: Send + Sync {
    /// When the current connection code was created (RFC 3339), when the
    /// token file records it.
    fn connection_code_created_at(&self) -> ApplicationFuture<Option<String>>;
    /// Atomically replaces the stored token with a new one and returns it.
    /// The old token must not be usable once this returns.
    fn rotate_connection_code(&self) -> ApplicationFuture<RotatedConnectionCode>;
    /// Persists the exposure, so the next start binds the same way.
    fn save_exposure(&self, exposure: GatewayExposure) -> ApplicationFuture<()>;
}

/// Why an allowed host name was refused.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum AllowedHostError {
    /// Blank after trimming.
    #[error("the host name is empty")]
    Empty,
    /// Not `name`, `name:port`, an IP address or `[IPv6]:port`, or a URL.
    #[error("`{0}` is not a host name or host:port")]
    Invalid(String),
}

/// `value` as the gateway compares it (trimmed, lower case), when it is a
/// DNS name, an IPv4 address or a bracketed IPv6 address, with an optional
/// port. URLs (`https://name/`) and user info are refused.
pub fn normalize_allowed_host(value: &str) -> Result<String, AllowedHostError> {
    let host = value.trim().to_ascii_lowercase();
    if host.is_empty() {
        return Err(AllowedHostError::Empty);
    }
    let invalid = || AllowedHostError::Invalid(value.trim().to_owned());
    if host.len() > MAX_HOST_LENGTH {
        return Err(invalid());
    }
    let (name, port) = split_port(&host).ok_or_else(invalid)?;
    let name_ok = match name
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
    {
        Some(literal) => literal.parse::<Ipv6Addr>().is_ok(),
        None => name.parse::<IpAddr>().is_ok() || is_dns_name(name),
    };
    let port_ok = port.is_none_or(|port| port.parse::<u16>().is_ok_and(|port| port > 0));
    if name_ok && port_ok {
        Ok(host)
    } else {
        Err(invalid())
    }
}

/// `name[:port]`; a bracketed IPv6 literal keeps its colons.
fn split_port(host: &str) -> Option<(&str, Option<&str>)> {
    if host.starts_with('[') {
        let close = host.find(']')?;
        let (name, rest) = host.split_at(close + 1);
        return match rest.strip_prefix(':') {
            Some(port) => Some((name, Some(port))),
            None if rest.is_empty() => Some((name, None)),
            None => None,
        };
    }
    match host.split_once(':') {
        Some((name, port)) if !port.contains(':') => Some((name, Some(port))),
        Some(_) => None,
        None => Some((host, None)),
    }
}

fn is_dns_name(name: &str) -> bool {
    let name = name.strip_suffix('.').unwrap_or(name);
    !name.is_empty()
        && name.split('.').all(|label| {
            (1..=63).contains(&label.len())
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
}
