//! Interface addresses from `getifaddrs`.

use std::net::IpAddr;

use nix::ifaddrs::getifaddrs;
use nix::net::if_::InterfaceFlags;

pub(super) const INTERFACE_ADDRESSES: bool = true;

pub(super) fn external_addresses() -> Option<Vec<IpAddr>> {
    let interfaces = getifaddrs().ok()?;
    Some(
        interfaces
            .filter(|interface| {
                interface.flags.contains(InterfaceFlags::IFF_UP)
                    && !interface.flags.contains(InterfaceFlags::IFF_LOOPBACK)
            })
            .filter_map(|interface| {
                let address = interface.address?;
                address
                    .as_sockaddr_in()
                    .map(|address| IpAddr::V4(address.ip()))
                    .or_else(|| {
                        address
                            .as_sockaddr_in6()
                            .map(|address| IpAddr::V6(address.ip()))
                    })
            })
            .filter(|ip| !ip.is_loopback())
            .collect(),
    )
}
