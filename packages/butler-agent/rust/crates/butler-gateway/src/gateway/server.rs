//! The App HTTP listener: its configuration and the served gateway's
//! lifetime.

use std::{net::SocketAddr, sync::Arc};

use tokio::{net::TcpListener, task::JoinHandle};
use tokio_util::sync::CancellationToken;

use super::{GatewayApplication, LocalAuthConfig, http};

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
    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    /// Stop admission, terminate live streams, and wait for the listener task.
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

pub fn serve_gateway(
    listener: TcpListener,
    application: Arc<dyn GatewayApplication>,
    config: GatewayConfig,
) -> std::io::Result<GatewayServer> {
    let local_addr = listener.local_addr()?;
    let shutdown = CancellationToken::new();
    let router = http::router(application, config, shutdown.clone(), local_addr);
    let graceful = shutdown.clone();
    let task = tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(graceful.cancelled_owned())
            .await
    });
    Ok(GatewayServer {
        local_addr,
        shutdown,
        task: Some(task),
    })
}
