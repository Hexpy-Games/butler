//! One process model catalog/client; request snapshots remain request-owned.

use std::path::PathBuf;
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

use crate::btcc::BtccError;
use crate::configuration::ConfigurationWrites;
use crate::locale::LocaleCollation;
use crate::mcp_client::NativeMcpClient;
use crate::models::{
    ModelCatalog, ModelConfiguration, ModelConfigurationEnvironment, NativeModelProvider,
    ProviderObservation, ProviderObservationSink, provider_http_client,
};
use crate::operations::PromptUsageMetrics;

use super::SystemIdentity;

pub(crate) struct NativeProcessModels {
    pub catalog: Arc<ModelCatalog>,
    pub configuration: Arc<ModelConfiguration>,
    pub provider: Arc<NativeModelProvider>,
}

impl NativeProcessModels {
    pub(crate) fn new(
        data_root: PathBuf,
        environment: ModelConfigurationEnvironment,
        writes: Arc<ConfigurationWrites>,
        collation: Arc<LocaleCollation>,
    ) -> Result<Self, BtccError> {
        Self::new_with_visual_capability(data_root, environment, writes, collation, None)
    }

    pub(crate) fn new_with_mcp(
        data_root: PathBuf,
        environment: ModelConfigurationEnvironment,
        writes: Arc<ConfigurationWrites>,
        collation: Arc<LocaleCollation>,
        mcp_client: Arc<NativeMcpClient>,
    ) -> Result<Self, BtccError> {
        Self::new_with_visual_capability(
            data_root,
            environment,
            writes,
            collation,
            Some(Arc::new(super::NativeZaiVisionCapability::new(mcp_client))),
        )
    }

    fn new_with_visual_capability(
        data_root: PathBuf,
        environment: ModelConfigurationEnvironment,
        writes: Arc<ConfigurationWrites>,
        collation: Arc<LocaleCollation>,
        visual_capability: Option<Arc<dyn crate::models::ProviderVisualCapabilityPort>>,
    ) -> Result<Self, BtccError> {
        let client = provider_http_client()
            .map_err(|error| BtccError::new("provider_client_unavailable", error.to_string()))?;
        let catalog = Arc::new(
            ModelCatalog::new()
                .map_err(|error| BtccError::new("model_catalog_unavailable", error.to_string()))?,
        );
        let configuration = Arc::new(
            ModelConfiguration::new(
                data_root.clone(),
                environment,
                Arc::new(SystemIdentity),
                catalog.clone(),
                collation,
                client.clone(),
                writes,
            )
            .map_err(|error| {
                BtccError::new("model_configuration_unavailable", error.to_string())
            })?,
        );
        let provider = NativeModelProvider::new(
            client,
            configuration.clone(),
            Arc::new(ProviderCounts::default()),
            catalog.clone(),
            Arc::new(SystemIdentity),
            Arc::new(PromptUsageMetrics::new(data_root, Arc::new(SystemIdentity))),
        );
        let provider = Arc::new(match visual_capability {
            Some(capability) => provider.with_visual_capability(capability),
            None => provider,
        });
        Ok(Self {
            catalog,
            configuration,
            provider,
        })
    }
}

/// Passive diagnostics retain counters only, never prompt text, auth or result bytes.
#[derive(Default)]
struct ProviderCounts {
    requests: AtomicU64,
    request_bytes: AtomicU64,
    responses: AtomicU64,
    failures: AtomicU64,
}

impl ProviderObservationSink for ProviderCounts {
    fn request(&self, observation: ProviderObservation) {
        self.requests.fetch_add(1, Ordering::Relaxed);
        self.request_bytes
            .fetch_add(observation.request_bytes as u64, Ordering::Relaxed);
    }
    fn response(&self, _: &str, _: &str) {
        self.responses.fetch_add(1, Ordering::Relaxed);
    }
    fn failure(&self, _: &crate::btcc::ProviderRequestError) {
        self.failures.fetch_add(1, Ordering::Relaxed);
    }
}
