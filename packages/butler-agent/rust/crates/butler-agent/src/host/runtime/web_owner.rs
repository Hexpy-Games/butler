//! Process model and dependent public-web owners opened as one composition.

use std::sync::Arc;

use butler_core::configuration::ConfigurationWrites;
use butler_core::locale::LocaleCollation;
use butler_models::mcp_client::McpClient;
use butler_models::models::ModelConfigurationEnvironment;
use butler_runtime::operations::WebSearchMetrics;
use butler_runtime::web_access::WebAccess;
use butler_turn::btcc::BtccError;

use super::super::ProcessModels;
use super::RuntimePaths;
use super::startup_trace::Trace;

pub(super) struct ProcessWebServices {
    pub models: ProcessModels,
    pub web_access: Arc<WebAccess>,
}

/// Marks the end of in-memory configuration, then times the model and web
/// owners and the credential move as separate startup phases.
pub(super) async fn open(
    paths: &RuntimePaths,
    model_environment: ModelConfigurationEnvironment,
    writes: &Arc<ConfigurationWrites>,
    collation: &Arc<LocaleCollation>,
    mcp_client: Arc<McpClient>,
    startup: &mut Trace,
) -> Result<ProcessWebServices, BtccError> {
    startup.phase("configuration");
    let models = ProcessModels::new_with_mcp(
        paths.data_root.clone(),
        model_environment,
        writes.clone(),
        collation.clone(),
        mcp_client,
    )?;
    let web_access = Arc::new(
        WebAccess::new(
            paths.data_root.clone(),
            models.configuration.clone(),
            models.provider.clone(),
            Arc::new(WebSearchMetrics::new(paths.data_root.clone())),
        )
        .map_err(|error| BtccError::relayed(error.code(), error.message()))?,
    );
    startup.phase("web_owner");
    let models = super::models::with_moved_credentials(models).await;
    startup.phase("model_credentials");
    Ok(ProcessWebServices { models, web_access })
}
