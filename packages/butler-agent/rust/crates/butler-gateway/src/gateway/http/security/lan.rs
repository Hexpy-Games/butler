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

#[cfg(test)]
mod tests {
    use super::*;

    /// Security boundary: the addresses remote access may bind.
    #[test]
    fn only_private_network_addresses_are_lan_addresses() {
        let cases = [
            ("192.168.0.20", true),
            ("10.0.0.2", true),
            ("172.16.4.2", true),
            ("100.101.102.103", false),
            ("169.254.10.1", true),
            ("fd12:3456::1", true),
            ("::ffff:10.1.2.3", true),
            ("127.0.0.1", false),
            ("::1", false),
            ("8.8.8.8", false),
            ("172.32.0.1", false),
            ("100.128.0.1", false),
            ("fe80::1", false),
            ("2001:db8::1", false),
            ("0.0.0.0", false),
        ];
        for (ip, lan) in cases {
            assert_eq!(is_lan_address(ip.parse().unwrap()), lan, "{ip}");
        }
    }

    #[test]
    fn mdns_name_is_the_first_label_with_local() {
        let cases = [
            ("Studio-MacBook-Pro.local", Some("studio-macbook-pro.local")),
            ("buildbox", Some("buildbox.local")),
            ("desk.example.com", Some("desk.local")),
            ("", None),
            ("bad_name", None),
        ];
        for (host, expected) in cases {
            assert_eq!(mdns_name_of(host).as_deref(), expected, "{host}");
        }
    }
}
