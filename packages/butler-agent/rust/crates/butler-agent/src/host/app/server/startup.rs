//! Initialize App owners before spawning either loopback or LAN accept tasks.

use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use butler_gateway::gateway::{AppApplication, GatewayConfig, GatewayServer, serve_gateway};
use butler_turn::btcc::BtccError;
use tokio::net::TcpListener;

use super::AppSetup;
use crate::host::service::entrypoint::STARTUP_TIMEOUT;

pub(super) async fn activate(
    listener: TcpListener,
    application: Arc<AppApplication>,
    config: GatewayConfig,
    setup: &AppSetup,
    listener_ready: &AtomicBool,
    data_root: &Path,
) -> Result<GatewayServer, BtccError> {
    // Native admission is initialized. Enable internal recovery without HTTP:
    // the reserved listener still has no accept task.
    listener_ready.store(true, Ordering::Release);
    #[cfg(not(debug_assertions))]
    let _ = data_root;
    let initialization = async {
        #[cfg(debug_assertions)]
        super::startup_hold::wait(data_root).await?;
        super::start_application(&application)
            .await
            .map_err(super::app_error)
    };
    let initialized = tokio::time::timeout(STARTUP_TIMEOUT, initialization)
        .await
        .unwrap_or_else(|_| {
            Err(BtccError::relayed(
                "native_service_start_timeout",
                "App owners did not initialize within the startup deadline",
            ))
        });
    if let Err(error) = initialized {
        listener_ready.store(false, Ordering::Release);
        setup.close().await;
        let _ = application.close().await;
        return Err(error);
    }
    // serve_gateway starts both loopback and saved LAN exposure. Only now can
    // requests leave the kernel backlog and reach the initialized application.
    match serve_gateway(listener, application.clone(), config).await {
        Ok(server) => Ok(server),
        Err(error) => {
            listener_ready.store(false, Ordering::Release);
            setup.close().await;
            let _ = application.close().await;
            Err(BtccError::relayed(
                "app_listener_start_failed",
                error.to_string(),
            ))
        }
    }
}
