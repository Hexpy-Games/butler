//! The effective App endpoint published by the live App owner.

use parking_lot::RwLock;
use std::{net::SocketAddr, path::PathBuf};

use crate::host::service::configuration::AppServiceConfiguration;
use butler_gateway::gateway::LocalAuthConfig;

#[derive(Clone, Default)]
pub(crate) struct ActiveAppEndpoint {
    current: std::sync::Arc<RwLock<Option<ActiveAppEndpointSnapshot>>>,
}

#[derive(Clone)]
pub(crate) struct ActiveAppEndpointSnapshot {
    pub(crate) base_url: String,
    pub(crate) local_auth: LocalAuthConfig,
    pub(crate) configured_host: String,
    pub(crate) configured_port: u16,
    pub(crate) database_path: PathBuf,
}

impl ActiveAppEndpoint {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn snapshot(&self) -> Option<ActiveAppEndpointSnapshot> {
        self.current.read().clone()
    }

    pub(crate) fn publish(&self, address: SocketAddr, configuration: &AppServiceConfiguration) {
        let snapshot = ActiveAppEndpointSnapshot {
            base_url: format!("http://{address}"),
            local_auth: configuration.gateway_config().local_auth,
            configured_host: configuration.host.clone(),
            configured_port: configuration.port,
            database_path: configuration.db_path.clone(),
        };
        *self.current.write() = Some(snapshot);
    }

    /// Points at a test server.
    #[cfg(test)]
    pub(crate) fn publish_for_test(&self, base_url: String, local_auth: LocalAuthConfig) {
        *self.current.write() = Some(ActiveAppEndpointSnapshot {
            base_url,
            local_auth,
            configured_host: "127.0.0.1".into(),
            configured_port: 0,
            database_path: PathBuf::new(),
        });
    }

    pub(crate) fn clear(&self) {
        *self.current.write() = None;
    }
}
