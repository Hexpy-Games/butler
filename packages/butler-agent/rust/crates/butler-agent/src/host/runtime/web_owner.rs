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

pub(super) struct ProcessWebServices {
    pub models: ProcessModels,
    pub web_access: Arc<WebAccess>,
}

pub(super) fn open(
    paths: &RuntimePaths,
    model_environment: ModelConfigurationEnvironment,
    writes: &Arc<ConfigurationWrites>,
    collation: &Arc<LocaleCollation>,
    mcp_client: Arc<McpClient>,
) -> Result<ProcessWebServices, BtccError> {
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
    Ok(ProcessWebServices { models, web_access })
}
