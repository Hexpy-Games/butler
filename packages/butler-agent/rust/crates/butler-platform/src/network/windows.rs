//! Interface addresses are not listed on Windows yet.

use std::net::IpAddr;

pub(super) const INTERFACE_ADDRESSES: bool = false;

pub(super) fn external_addresses() -> Option<Vec<IpAddr>> {
    None
}
