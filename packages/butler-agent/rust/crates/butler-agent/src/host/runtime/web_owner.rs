//! Process model and dependent public-web owners opened as one composition.

use std::sync::Arc;

use crate::btcc::BtccError;
use crate::mcp_client::McpClient;
use crate::models::ModelConfigurationEnvironment;
use crate::operations::WebSearchMetrics;
use crate::web_access::WebAccess;
use butler_core::configuration::ConfigurationWrites;
use butler_core::locale::LocaleCollation;

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
