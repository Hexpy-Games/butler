//! The gateway's TCP listeners: the loopback listener it starts with, and
//! the LAN listeners remote access binds and unbinds while it runs (same
//! port, one per LAN address). Every listener records the TCP peer, which
//! Settings → Security uses to tell local clients from remote ones.

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use axum::Extension;
use axum::extract::DefaultBodyLimit;
use axum::serve::ListenerExt;
use parking_lot::Mutex;
use serde::Serialize;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::security::lan;
use super::{HttpState, MAX_REQUEST_BODY_SIZE};
use crate::gateway::GatewayExposure;

/// Request extension: the listener a request came through. Live streams
/// served through a LAN listener close when remote access is turned off.
#[derive(Clone)]
pub(super) struct ListenerScope {
    pub(super) closed: CancellationToken,
}

/// Serves `listener` until `closed` fires.
pub(super) fn spawn(
    listener: TcpListener,
    state: Arc<HttpState>,
    closed: CancellationToken,
) -> JoinHandle<std::io::Result<()>> {
    let service = super::router::routes()
        .with_state(state)
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BODY_SIZE))
        .layer(Extension(ListenerScope {
            closed: closed.clone(),
        }))
        .into_make_service_with_connect_info::<SocketAddr>();
    tokio::spawn(async move {
        // Small JSON/SSE tails must not wait for an acknowledgement of a
        // preceding packet. Apply to loopback and dynamically bound LAN peers.
        let listener = listener.tap_io(|stream| {
            if let Err(error) = stream.set_nodelay(true) {
                butler_core::diagnostic!("[gateway] TCP_NODELAY unavailable: {error}");
            }
        });
        axum::serve(listener, service)
            .with_graceful_shutdown(closed.cancelled_owned())
            .await
    })
}

/// A LAN address that could not be bound, visible to the local admin.
#[derive(Clone, Debug, Serialize)]
pub(super) struct BindError {
    address: SocketAddr,
    code: &'static str,
    error: String,
}

impl BindError {
    fn new(address: SocketAddr, error: std::io::Error) -> Self {
        let code = match error.kind() {
            std::io::ErrorKind::AddrInUse => "address_in_use",
            std::io::ErrorKind::PermissionDenied => "permission_denied",
            std::io::ErrorKind::AddrNotAvailable => "address_unavailable",
            _ => "bind_failed",
        };
        Self {
            address,
            code,
            error: error.to_string(),
        }
    }
}

/// What remote access currently exposes.
#[derive(Clone, Debug, Default)]
pub(super) struct RemoteSnapshot {
    pub(super) exposure: GatewayExposure,
    /// The LAN listeners' addresses.
    pub(super) lan_listeners: Vec<SocketAddr>,
    pub(super) content_listeners: Vec<SocketAddr>,
    pub(super) bind_errors: Vec<BindError>,
    /// The LAN Host authorities answered: `ip:port`, `<name>.local:port`.
    pub(super) lan_authorities: Vec<String>,
}

/// The gateway's exposure beyond loopback, changed by Settings → Security.
pub(super) struct RemoteAccess {
    primary: SocketAddr,
    content_addr: SocketAddr,
    current: Mutex<RemoteState>,
    /// Serializes changes (persist, then apply) and connection-code rotation.
    pub(super) changes: tokio::sync::Mutex<()>,
}

#[derive(Default)]
struct RemoteState {
    snapshot: RemoteSnapshot,
    /// Stops the LAN listeners and their live streams.
    closed: Option<CancellationToken>,
}

impl RemoteAccess {
    pub(super) fn new(
        primary: SocketAddr,
        content_addr: SocketAddr,
        allowed_hosts: Vec<String>,
    ) -> Self {
        let snapshot = RemoteSnapshot {
            exposure: GatewayExposure {
                remote_access_enabled: false,
                allowed_hosts,
                content_hosts: Vec::new(),
            },
            ..RemoteSnapshot::default()
        };
        Self {
            primary,
            content_addr,
            current: Mutex::new(RemoteState {
                snapshot,
                closed: None,
            }),
            changes: tokio::sync::Mutex::new(()),
        }
    }

    /// The loopback listener's address.
    pub(super) fn primary(&self) -> SocketAddr {
        self.primary
    }

    pub(super) fn content_addr(&self) -> SocketAddr {
        self.content_addr
    }

    pub(super) fn snapshot(&self) -> RemoteSnapshot {
        self.current.lock().snapshot.clone()
    }

    /// Binds or unbinds the LAN listeners for `exposure` and makes the
    /// gateway answer exactly its names. Turning remote access on binds
    /// every LAN address that is free; one that is not is skipped.
    pub(super) fn apply(
        &self,
        state: &Arc<HttpState>,
        exposure: GatewayExposure,
    ) -> RemoteSnapshot {
        let mut current = self.current.lock();
        let was_enabled = current.snapshot.exposure.remote_access_enabled;
        if was_enabled && !exposure.remote_access_enabled {
            if let Some(closed) = current.closed.take() {
                closed.cancel();
            }
            current.snapshot.lan_listeners.clear();
            current.snapshot.content_listeners.clear();
            current.snapshot.lan_authorities.clear();
            current.snapshot.bind_errors.clear();
        } else if !was_enabled && exposure.remote_access_enabled {
            let closed = state.shutdown.child_token();
            let bound = self.bind_lan(state, &closed);
            current.snapshot.lan_listeners = bound.lan_listeners;
            current.snapshot.content_listeners = bound.content_listeners;
            current.snapshot.lan_authorities = bound.lan_authorities;
            current.snapshot.bind_errors = bound.bind_errors;
            current.closed = Some(closed);
        }
        current.snapshot.exposure = exposure;
        state.security.set_hosts(
            &current.snapshot.exposure.allowed_hosts,
            &current.snapshot.lan_authorities,
        );
        current.snapshot.clone()
    }

    /// Binds `ip:port` for every LAN address (unless the loopback listener
    /// already listens on every interface) and names them.
    fn bind_lan(&self, state: &Arc<HttpState>, closed: &CancellationToken) -> RemoteSnapshot {
        let port = self.primary.port();
        let every_interface = self.primary.ip().is_unspecified();
        let mut bound = RemoteSnapshot::default();
        for ip in lan::lan_addresses() {
            let address = SocketAddr::new(ip, port);
            if !every_interface {
                match bind(address) {
                    Ok(listener) => {
                        let content_address = SocketAddr::new(ip, super::content::port(state));
                        let content_listener = match bind(content_address) {
                            Ok(listener) => listener,
                            Err(error) => {
                                bound
                                    .bind_errors
                                    .push(BindError::new(content_address, error));
                                continue;
                            }
                        };
                        match content_listener.local_addr() {
                            Ok(address) => bound.content_listeners.push(address),
                            Err(error) => {
                                bound
                                    .bind_errors
                                    .push(BindError::new(content_address, error));
                                continue;
                            }
                        }
                        super::content::spawn(content_listener, state.clone(), closed.clone());
                        drop(spawn(listener, state.clone(), closed.clone()));
                        bound.lan_listeners.push(address);
                    }
                    Err(error) => {
                        bound.bind_errors.push(BindError::new(address, error));
                        continue;
                    }
                }
            }
            bound.lan_authorities.push(authority(ip, port));
        }
        if !bound.lan_authorities.is_empty()
            && let Some(name) = lan::mdns_name()
        {
            bound.lan_authorities.push(format!("{name}:{port}"));
        }
        bound
    }
}

/// A non-blocking listener on `address`, retaining its bind failure.
fn bind(address: SocketAddr) -> std::io::Result<TcpListener> {
    let listener = std::net::TcpListener::bind(address)?;
    listener.set_nonblocking(true)?;
    TcpListener::from_std(listener)
}

fn authority(ip: IpAddr, port: u16) -> String {
    SocketAddr::new(ip, port).to_string()
}
