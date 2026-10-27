//! The effective App endpoint published by the live App owner.

use parking_lot::RwLock;
use std::{net::SocketAddr, path::PathBuf};

use crate::host::service::configuration::AppServiceConfiguration;
use butler_gateway::gateway::LocalAuthConfig;

#[derive(Clone)]
pub(crate) struct ActiveAppEndpoint {
    changes: tokio::sync::watch::Sender<(u64, bool)>,
    application:
        std::sync::Arc<RwLock<Option<std::sync::Arc<butler_gateway::gateway::AppApplication>>>>,
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
        let (changes, _) = tokio::sync::watch::channel((0, false));
        Self {
            changes,
            application: Default::default(),
            current: Default::default(),
        }
    }
}

impl ActiveAppEndpoint {
    pub(crate) fn subscribe_changes(&self) -> tokio::sync::watch::Receiver<(u64, bool)> {
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
        self.changes.send_modify(|state| state.1 = false);
    }

    pub(crate) fn publish_application(
        &self,
        application: std::sync::Arc<butler_gateway::gateway::AppApplication>,
    ) {
        *self.application.write() = Some(application);
        self.changes.send_modify(|state| state.1 = false);
    }

    pub(crate) async fn application(
        &self,
    ) -> Option<std::sync::Arc<butler_gateway::gateway::AppApplication>> {
        let mut changes = self.subscribe_changes();
        let generation = changes.borrow_and_update().0;
        loop {
            let state = *changes.borrow_and_update();
            if state.1 || state.0 != generation {
                return None;
            }
            if let Some(application) = self.application.read().clone() {
                return Some(application);
            }
            changes.changed().await.ok()?;
        }
    }

    pub(crate) fn clear(&self) {
        *self.application.write() = None;
        *self.current.write() = None;
        self.changes.send_modify(|state| {
            state.0 += 1;
            state.1 = true;
        });
    }
}
