//! `allowedHostName.ts`: a host name as the gateway stores it. The gateway has the final say.
use std::net::Ipv6Addr;

/// Longest host name (RFC 1035), plus room for `:port`.
const MAX_HOST_LENGTH: usize = 253 + 6;

/// `value` trimmed and lower case when it is a DNS name, an IPv4 address or a bracketed IPv6
/// address, with an optional port; `None` otherwise.
pub(super) fn normalize(value: &str) -> Option<String> {
    let host = value.trim().to_lowercase();
    if host.is_empty() || host.len() > MAX_HOST_LENGTH {
        return None;
    }
    let (name, port) = split_port(&host)?;
    if port.is_some_and(|port| !is_port(port)) {
        return None;
    }
    let valid = match name.strip_prefix('[') {
        Some(rest) => is_ipv6(rest.strip_suffix(']').unwrap_or(rest)),
        None => is_dns_name(name),
    };
    valid.then_some(host)
}

/// `name[:port]`; a bracketed IPv6 literal keeps its colons.
fn split_port(host: &str) -> Option<(&str, Option<&str>)> {
    if host.starts_with('[') {
        let (name, rest) = host.split_at(host.find(']')? + 1);
        if rest.is_empty() {
            return Some((name, None));
        }
        return rest.strip_prefix(':').map(|port| (name, Some(port)));
    }
    let mut parts = host.split(':');
    let name = parts.next()?;
    let port = parts.next();
    parts.next().is_none().then_some((name, port))
}

fn is_port(port: &str) -> bool {
    port.len() <= 5
        && port.bytes().all(|byte| byte.is_ascii_digit())
        && port
            .parse::<u32>()
            .is_ok_and(|port| (1..=65_535).contains(&port))
}

fn is_dns_name(name: &str) -> bool {
    let bare = name.strip_suffix('.').unwrap_or(name);
    !bare.is_empty() && bare.split('.').all(is_label)
}

/// `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`
fn is_label(label: &str) -> bool {
    let bytes = label.as_bytes();
    let alnum = |byte: &u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    let (Some(first), Some(last)) = (bytes.first(), bytes.last()) else {
        return false;
    };
    bytes.len() <= 63 && alnum(first) && alnum(last) && bytes.iter().all(|b| alnum(b) || *b == b'-')
}

fn is_ipv6(literal: &str) -> bool {
    literal.contains(':') && literal.parse::<Ipv6Addr>().is_ok()
}
