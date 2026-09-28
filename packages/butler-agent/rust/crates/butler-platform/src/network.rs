//! The machine's own network addresses, for the gateway's remote access
//! (Settings → Security): it binds its port on the LAN addresses among
//! them.
//!
//! Unix lists them with `getifaddrs`. Windows does not list them yet
//! ([`INTERFACE_ADDRESSES`] is false), so remote access binds nothing there.

use std::net::IpAddr;

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as sys;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as sys;

/// Whether this host can list its interface addresses.
pub const INTERFACE_ADDRESSES: bool = sys::INTERFACE_ADDRESSES;

/// The IPv4 and IPv6 addresses of the interfaces that are up and not
/// loopback, sorted and without duplicates; `None` without
/// [`INTERFACE_ADDRESSES`] or when the list cannot be read.
pub fn external_addresses() -> Option<Vec<IpAddr>> {
    let mut addresses = sys::external_addresses()?;
    addresses.sort_unstable();
    addresses.dedup();
    Some(addresses)
}
