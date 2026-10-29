//! Host-owned local plugin administration, unavailable to model tools.
mod connectors;
pub use connectors::{
    Account as ConnectorAccount, Connector as ConnectorDefinition, ConnectorStore,
    Handling as ConnectorHandling, SharedStore as ConnectorStoreRef, failure as connector_failure,
    matches as connector_matches, validate as validate_connector_event,
};
use serde_json::Value;
use std::{future::Future, pin::Pin};
/// Public, secret-free plugin failure.
#[derive(Debug, thiserror::Error)]
#[error("{code}")]
pub struct PluginError {
    /// HTTP status for the admin route.
    pub status: u16,
    /// Stable failure code, never package or secret bytes.
    pub code: &'static str,
}
/// An asynchronous administration operation.
pub type PluginFuture<'a> = Pin<Box<dyn Future<Output = Result<Value, PluginError>> + Send + 'a>>;
/// A host registry; all filesystem and credential work runs on blocking threads.
pub trait PluginPort: Send + Sync {
    /// Process-local mode without enumerating packages.
    fn safe_mode(&self) -> bool;
    /// Attach the App storage/admission owner once it is ready.
    fn bind_connector_store(&self, _store: ConnectorStoreRef) {}
    /// Inventory, revision and process-local safe mode.
    fn list(&self) -> PluginFuture<'_>;
    /// Inspect, install, enable, disable or uninstall. Inputs are admin-authenticated.
    fn execute(&self, action: String, id: Option<String>, input: Value) -> PluginFuture<'_>;
}
