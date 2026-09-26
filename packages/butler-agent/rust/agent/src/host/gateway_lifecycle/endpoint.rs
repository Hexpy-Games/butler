//! The effective App endpoint published by the live App owner.

use std::{net::SocketAddr, path::PathBuf, sync::RwLock};

use crate::{gateway::LocalAuthConfig, host::service_configuration::NativeAppServiceConfiguration};

#[derive(Clone, Default)]
pub(crate) struct NativeActiveAppEndpoint {
    current: std::sync::Arc<RwLock<Option<NativeActiveAppEndpointSnapshot>>>,
}

#[derive(Clone)]
pub(crate) struct NativeActiveAppEndpointSnapshot {
    pub(crate) base_url: String,
    pub(crate) local_auth: LocalAuthConfig,
    pub(crate) configured_host: String,
    pub(crate) configured_port: u16,
    pub(crate) database_path: PathBuf,
}

impl NativeActiveAppEndpoint {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn snapshot(&self) -> Option<NativeActiveAppEndpointSnapshot> {
        self.current.read().ok()?.clone()
    }

    pub(crate) fn publish(
        &self,
        address: SocketAddr,
        configuration: &NativeAppServiceConfiguration,
    ) {
        let snapshot = NativeActiveAppEndpointSnapshot {
            base_url: format!("http://{address}"),
            local_auth: configuration.gateway_config().local_auth,
            configured_host: configuration.host.clone(),
            configured_port: configuration.port,
            database_path: configuration.db_path.clone(),
        };
        if let Ok(mut current) = self.current.write() {
            *current = Some(snapshot);
        }
    }

    pub(crate) fn clear(&self) {
        if let Ok(mut current) = self.current.write() {
            *current = None;
        }
    }
}
