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
    content_addr: SocketAddr,
) -> JoinHandle<std::io::Result<()>> {
    tokio::spawn(async move {
        let devices = prepare_devices(application.clone(), shutdown.clone(), local_addr).await?;
        let exposure = GatewayExposure {
            remote_access_enabled: config.remote_access_enabled,
            allowed_hosts: config.allowed_hosts.clone(),
            content_hosts: config.content_hosts.clone(),
        };
        let remote =
            listeners::RemoteAccess::new(local_addr, content_addr, config.allowed_hosts.clone());
        let app_host = app_host(config.headless_browser.as_ref(), &shutdown);
        clear_opened_files(config.output_data.clone()).await;
        let headless = headless(config.headless_browser, &remote, &shutdown);
        let state = Arc::new(HttpState {
            browser: Arc::new(super::browser_host::Hub::default()),
            headless,
            app_host,
            previews: butler_runtime::previews::Previews::default(),
            preview_lifetime_started: parking_lot::Mutex::new(false),
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
            remote,
            security_store: config.security_store,
            session_cursor_secret: uuid::Uuid::new_v4().to_string(),
            limiter: FixedWindowRateLimiter::new(
                config.message_rate_limit_max,
                config.message_rate_limit_window,
            ),
            shutdown: shutdown.clone(),
            favicons: Arc::new(super::favicons::Favicons::new(config.favicon_cache_root)),
            uploads: tokio::sync::Semaphore::new(2),
            static_ui_root: config.static_ui_root,
            output_data: config.output_data,
            signin_secrets: super::signin_secrets::SignInSecrets::new(),
            browser_import: super::browser_import::ImportSessions::default(),
            import_dependencies: config.browser_import,
            agent_imports: super::agent_import::AgentImports::default(),
        });
        // Publish the saved exposure before loopback admission: a successful
        // health probe must not race initialization of Settings → Security.
        state.remote.apply(&state, exposure);
        browser_ports(&state);
        super::content::spawn(content_listener, state.clone(), shutdown.clone());
        let result = listeners::spawn(listener, state.clone(), shutdown)
            .await
            .map_err(std::io::Error::other)?;
        if let Some(headless) = &state.headless {
            headless.shutdown().await;
        }
        if let Some(host) = &state.app_host {
            host.shutdown().await;
        }
        clear_opened_files(state.output_data.clone()).await;
        result
    })
}

/// Copies opened in another app last until the gateway starts or stops.
async fn clear_opened_files(root: Option<std::path::PathBuf>) {
    let Some(root) = root else { return };
    let cleared = tokio::task::spawn_blocking(move || super::opened_files::clear(&root)).await;
    if let Ok(Err(error)) = cleared {
        tracing::warn!(%error, "opened-file copies were not removed");
    }
}

/// Reader renders and headless downloads go through this gateway.
fn browser_ports(state: &Arc<HttpState>) {
    butler_runtime::browser::set_render_port(Arc::new(super::browser_host::reader::ReaderPort(
        Arc::downgrade(state),
    )));
    if let Some(headless) = &state.headless {
        headless.set_history_port(Arc::new(super::library::history::HeadlessHistory(
            Arc::downgrade(state),
        )));
        headless.set_download_port(Arc::new(super::browser_host::downloads::HeadlessDownloads(
            Arc::downgrade(state),
        )));
    }
}

/// Give headless egress the same content port as the bound listener.
fn headless(
    browser: Option<crate::gateway::HeadlessBrowserConfig>,
    remote: &listeners::RemoteAccess,
    shutdown: &CancellationToken,
) -> Option<Arc<butler_runtime::browser::Headless>> {
    let browser = browser?;
    Some(butler_runtime::browser::Headless::new(
        butler_runtime::browser::HeadlessConfig {
            root: browser.root,
            install: browser.install,
            content: Some(butler_runtime::browser::ContentOrigin(
                remote.content_addr().port(),
            )),
            enabled: browser.enabled,
        },
        shutdown.clone(),
    ))
}

/// The hidden App host, where the browser without the App may use one.
fn app_host(
    browser: Option<&crate::gateway::HeadlessBrowserConfig>,
    shutdown: &CancellationToken,
) -> Option<Arc<butler_runtime::browser::AppHost>> {
    let browser = browser?;
    if matches!(
        browser.app_host,
        butler_runtime::browser::AppHostSource::Off
    ) {
        return None;
    }
    Some(butler_runtime::browser::AppHost::new(
        butler_runtime::browser::AppHostConfig {
            root: browser.app_host_root.clone(),
            source: browser.app_host.clone(),
        },
        shutdown.clone(),
    ))
}

async fn prepare_devices(
    application: Arc<dyn GatewayApplication>,
    shutdown: CancellationToken,
    local_addr: SocketAddr,
) -> std::io::Result<security::DeviceRegistry> {
    super::logs::initialize(application.clone(), shutdown.clone())
        .await
        .map_err(|_| std::io::Error::other("log configuration unavailable"))?;
    security::DeviceRegistry::load(application, local_addr.port(), shutdown)
        .await
        .map_err(|_| std::io::Error::other("device registry unavailable"))
}
