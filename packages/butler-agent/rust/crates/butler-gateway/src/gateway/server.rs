//! Starting and stopping the gateway listener.

use std::{net::SocketAddr, sync::Arc};

use tokio::{net::TcpListener, task::JoinHandle};
use tokio_util::sync::CancellationToken;

use super::{GatewayApplication, GatewaySecurityStore, LocalAuthConfig, http};

/// Listener configuration for [`serve_gateway`].
pub struct GatewayConfig {
    /// The local bearer token; it also keys signed URLs and browser sessions.
    pub local_auth: LocalAuthConfig,
    /// `BUTLER_APP_DEV_ORIGIN`: extra renderer origins (comma-separated,
    /// compared as raw strings), allowed only when set.
    pub dev_cors_origin: Option<String>,
    /// Extra Host names the gateway answers besides loopback (`name` or
    /// `name:port`); their `http`/`https` origins are allowed too.
    pub allowed_hosts: Vec<String>,
    pub content_hosts: Vec<String>,
    pub output_data: Option<std::path::PathBuf>,
    /// Settings → Security: also listen on the machine's LAN addresses (same
    /// port) and answer their Host names.
    pub remote_access_enabled: bool,
    /// The local admin credential: Settings → Security answers only a
    /// loopback client that also sends it in [`ADMIN_CREDENTIAL_HEADER`].
    /// Without one, Settings → Security refuses everyone.
    ///
    /// [`ADMIN_CREDENTIAL_HEADER`]: super::ADMIN_CREDENTIAL_HEADER
    pub admin_credential: Option<String>,
    /// The host side of Settings → Security. Without one, exposure changes
    /// live in memory only and the connection code cannot rotate.
    pub security_store: Option<Arc<dyn GatewaySecurityStore>>,
    /// Lifetime of the signed message-file URLs in JSON responses.
    pub signed_url_ttl: std::time::Duration,
    pub message_rate_limit_max: u64,
    pub message_rate_limit_window: std::time::Duration,
    pub static_ui_root: Option<std::path::PathBuf>,
}

impl Default for GatewayConfig {
    fn default() -> Self {
        Self {
            local_auth: LocalAuthConfig::default(),
            dev_cors_origin: None,
            allowed_hosts: Vec::new(),
            content_hosts: Vec::new(),
            output_data: None,
            remote_access_enabled: false,
            admin_credential: None,
            security_store: None,
            signed_url_ttl: std::time::Duration::from_secs(600),
            message_rate_limit_max: 60,
            message_rate_limit_window: std::time::Duration::from_secs(60),
            static_ui_root: None,
        }
    }
}

pub struct GatewayServer {
    local_addr: SocketAddr,
    shutdown: CancellationToken,
    task: Option<JoinHandle<std::io::Result<()>>>,
}

impl GatewayServer {
    /// The loopback (primary) listener's address.
    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    /// Refuse new HTTP work without closing application storage or waiting for handlers.
    pub fn stop_accepting(&self) {
        self.shutdown.cancel();
    }

    /// Stop admission, terminate live streams, and wait for the listener task.
    /// LAN listeners stop with it.
    pub async fn close(mut self) -> std::io::Result<()> {
        self.shutdown.cancel();
        let Some(task) = self.task.take() else {
            return Ok(());
        };
        task.await.map_err(std::io::Error::other)?
    }
}

impl Drop for GatewayServer {
    fn drop(&mut self) {
        // Normal shutdown awaits `close`; partial initialization still stops
        // admission and streams instead of leaving a detached serving task.
        self.shutdown.cancel();
    }
}

/// Serves `listener` (the loopback listener), and the LAN listeners when
/// remote access is enabled.
pub async fn serve_gateway(
    listener: TcpListener,
    application: Arc<dyn GatewayApplication>,
    mut config: GatewayConfig,
) -> std::io::Result<GatewayServer> {
    validate_content_hosts(&mut config)?;
    let local_addr = listener.local_addr()?;
    let content_addr = SocketAddr::new(
        local_addr.ip(),
        local_addr
            .port()
            .checked_add(1)
            .ok_or_else(|| std::io::Error::other("content port overflow"))?,
    );
    let content_listener = if butler_core::product_features::BROWSER {
        Some(TcpListener::bind(content_addr).await?)
    } else {
        None
    };
    let shutdown = CancellationToken::new();
    let task = http::serve(
        listener,
        content_listener,
        application,
        config,
        shutdown.clone(),
        local_addr,
    );
    Ok(GatewayServer {
        local_addr,
        shutdown,
        task: Some(task),
    })
}

fn validate_content_hosts(config: &mut GatewayConfig) -> std::io::Result<()> {
    config.content_hosts = config
        .content_hosts
        .iter()
        .map(|host| {
            super::normalize_allowed_host(host)
                .map_err(|_| std::io::Error::other("invalid content host"))
        })
        .collect::<Result<_, _>>()?;
    let api_hosts: Vec<_> = config
        .allowed_hosts
        .iter()
        .filter_map(|host| super::normalize_allowed_host(host).ok())
        .collect();
    if config
        .content_hosts
        .iter()
        .any(|host| api_hosts.contains(host))
    {
        return Err(std::io::Error::other(
            "content host must use a separate origin",
        ));
    }
    Ok(())
}
