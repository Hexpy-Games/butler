//! The machine's own network addresses, for the gateway's remote access
//! (Settings → Security): it binds its port on the LAN addresses among
//! them.
//!
//! Unix lists them with `getifaddrs`; Windows uses `if-addrs` to enumerate
//! adapters. Both report IPv4 and IPv6 addresses of up interfaces.

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

/// Detect dead long-lived connections within a few minutes, including after sleep.
pub fn tcp_keepalive(stream: &tokio::net::TcpStream) -> std::io::Result<()> {
    let socket = socket2::SockRef::from(stream);
    socket.set_tcp_keepalive(
        &socket2::TcpKeepalive::new()
            .with_time(std::time::Duration::from_secs(120))
            .with_interval(std::time::Duration::from_secs(30)),
    )
}
