//! The effective App endpoint published by the live App owner.

use parking_lot::RwLock;
use std::{net::SocketAddr, path::PathBuf};

use crate::host::service::configuration::AppServiceConfiguration;
use butler_gateway::gateway::LocalAuthConfig;

#[derive(Clone)]
pub(crate) struct ActiveAppEndpoint {
    changes: tokio::sync::watch::Sender<()>,
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

impl Default for ActiveAppEndpoint {
    fn default() -> Self {
        let (changes, _) = tokio::sync::watch::channel(());
        Self {
            changes,
            current: Default::default(),
        }
    }
}

impl ActiveAppEndpoint {
    pub(crate) fn subscribe_changes(&self) -> tokio::sync::watch::Receiver<()> {
        self.changes.subscribe()
    }

    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn snapshot(&self) -> Option<ActiveAppEndpointSnapshot> {
        self.current.read().clone()
    }

    /// Publishes the running listener; `local_auth` is the token it enforces
    /// (shared, so a rotated connection code reaches every caller).
    pub(crate) fn publish(
        &self,
        address: SocketAddr,
        configuration: &AppServiceConfiguration,
        local_auth: LocalAuthConfig,
    ) {
        let snapshot = ActiveAppEndpointSnapshot {
            base_url: format!("http://{address}"),
            local_auth,
            configured_host: configuration.host.clone(),
            configured_port: address.port(),
            database_path: configuration.db_path.clone(),
        };
        *self.current.write() = Some(snapshot);
        self.changes.send_replace(());
    }

    pub(crate) fn clear(&self) {
        *self.current.write() = None;
        self.changes.send_replace(());
    }
}
