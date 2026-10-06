//! Load device credentials before opening HTTP admission.
use super::{FixedWindowRateLimiter, HttpState, listeners, security};
use crate::gateway::{GatewayApplication, GatewayConfig, GatewayExposure};
use std::{net::SocketAddr, sync::Arc};
use tokio::{net::TcpListener, task::JoinHandle};
use tokio_util::sync::CancellationToken;

/// Serves `listener` (loopback) until `shutdown`, and binds the LAN
/// listeners too when remote access is enabled.
pub(in crate::gateway) fn serve(
    listener: TcpListener,
    content_listener: TcpListener,
    application: Arc<dyn GatewayApplication>,
    config: GatewayConfig,
    shutdown: CancellationToken,
    local_addr: SocketAddr,
) -> JoinHandle<std::io::Result<()>> {
    tokio::spawn(async move {
        let devices = security::DeviceRegistry::load(
            application.clone(),
            local_addr.port(),
            shutdown.clone(),
        )
        .await
        .map_err(|_| std::io::Error::other("device registry unavailable"))?;
        let exposure = GatewayExposure {
            remote_access_enabled: config.remote_access_enabled,
            allowed_hosts: config.allowed_hosts.clone(),
            content_hosts: config.content_hosts.clone(),
        };
        let state = Arc::new(HttpState {
            application,
            devices,
            security: security::GatewaySecurity::new(security::SecurityConfig {
                auth: config.local_auth,
                admin: config.admin_credential,
                local_addr,
                allowed_hosts: config.allowed_hosts.clone(),
                dev_origins: config.dev_cors_origin,
                signed_url_ttl: config.signed_url_ttl,
                shutdown: shutdown.clone(),
            }),
            remote: listeners::RemoteAccess::new(local_addr, config.allowed_hosts),
            security_store: config.security_store,
            session_cursor_secret: uuid::Uuid::new_v4().to_string(),
            limiter: FixedWindowRateLimiter::new(
                config.message_rate_limit_max,
                config.message_rate_limit_window,
            ),
            shutdown: shutdown.clone(),
            uploads: tokio::sync::Semaphore::new(2),
            static_ui_root: config.static_ui_root,
            output_data: config.output_data,
        });
        // Publish the saved exposure before loopback admission: a successful
        // health probe must not race initialization of Settings → Security.
        state.remote.apply(&state, exposure);
        super::content::spawn(content_listener, state.clone(), shutdown.clone());
        listeners::spawn(listener, state, shutdown)
            .await
            .map_err(std::io::Error::other)?
    })
}
