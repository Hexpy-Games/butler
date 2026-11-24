//! The machine's LAN addresses and mDNS name, which remote access binds and
//! answers.

use std::net::IpAddr;

/// Whether `ip` is on a private network: RFC 1918, IPv4 link-local, or an
/// IPv6 unique local address. Loopback and public addresses are not, nor
/// IPv6 link-local ones (they need a zone to bind), nor the shared address
/// space 100.64.0.0/10 (carrier-grade NAT, and VPN overlays such as
/// Tailscale): expose a tailnet by forwarding to loopback (`tailscale
/// serve`) and registering its name as an allowed host.
pub(super) fn is_lan_address(ip: IpAddr) -> bool {
    match ip.to_canonical() {
        IpAddr::V4(ip) => ip.is_private() || ip.is_link_local(),
        IpAddr::V6(ip) => ip.segments()[0] & 0xfe00 == 0xfc00,
    }
}

/// The LAN addresses of the interfaces that are up and not loopback,
/// sorted and without duplicates (none where the host cannot list them).
pub(in crate::gateway::http) fn lan_addresses() -> Vec<IpAddr> {
    butler_platform::network::external_addresses()
        .unwrap_or_default()
        .into_iter()
        .filter(|ip| is_lan_address(*ip))
        .collect()
}

/// `<host>.local`, the name mDNS answers for this machine on the LAN.
pub(in crate::gateway::http) fn mdns_name() -> Option<String> {
    mdns_name_of(&butler_platform::instance::host_name().ok()?)
}

/// The first label of `host`, lower case, with `.local`.
fn mdns_name_of(host: &str) -> Option<String> {
    let label = host.split('.').next()?.trim().to_ascii_lowercase();
    let valid = (1..=63).contains(&label.len())
        && !label.starts_with('-')
        && label
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-');
    valid.then(|| format!("{label}.local"))
}
