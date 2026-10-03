//! Interface addresses through the safe Windows adapter enumeration API.

use std::net::IpAddr;

pub(super) const INTERFACE_ADDRESSES: bool = true;

pub(super) fn external_addresses() -> Option<Vec<IpAddr>> {
    Some(
        if_addrs::get_if_addrs()
            .ok()?
            .into_iter()
            .filter(|interface| interface.is_oper_up() && !interface.is_loopback())
            .map(|interface| interface.ip())
            .filter(|ip| !ip.is_loopback())
            .collect(),
    )
}
